// World politics engine bound to a game (docs/WORLD-POLITICS-CONTRACT.md §4, §6). Phase 1: new file, not wired.
// Phase 2 hooks (docs/WORLD-POLITICS-PHASE2.md) call the methods below from game.js, fleet.js, captain.js, server.js.
// Pure rules live in shared/politics.js; this class adds state (office.pol, vessel fields), dice and money.
//
// Host interface it uses (all optional except simTime/rnd/event): game.simTime, game.rnd(), game.event(p, kind, text),
// game.sink(p, reason), game.impound(p, by, fine), game.send(p, msg), game.harbors[hid].market[good],
// game.fleet.book(p, vid, cat, amt), game.fleet.tell(p, kind, text, v).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIP_CLASSES, GOODS } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';
import {
  POL, TEMPLATES, fill, loadDataset, makeCtx, matches, isActive, isStale, scaledS, dateToS, dateOf, areasAt, routeExposure,
  hullValue, hullBasis, warPremium, pDayOf, transitChance, piracyChance, guardsCost, incidentOutcome, pickShare,
  tradeCheck, jobCheck, entryCheck, harbourRules, riskCheck, avoidDiscs, pscRegimeOf, pscChance, vesselAge,
  registryOf, registryOwnerOk, reflagCost, inTerritory, portStatus, cabotageOf, tradeShare, destWeightFor, tradeProfileMul,
  srcShort, fmtDate, RISK_POLICIES, ecaPerT,
} from '../shared/politics.js';
import { HARBORS } from './harbors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIR = path.resolve(HERE, '../shared/politics');
export const DATA_FILES = ['meta', 'sources', 'countries', 'ports', 'registries', 'regimes', 'areas', 'agreements', 'tariffs', 'psc', 'trade'];
export const CLIENT_KEYS = ['meta', 'sources', 'countries', 'ports', 'registries', 'regimes', 'areas', 'agreements', 'tariffs', 'psc'];
const RECORDS_MAX = 40, CALLS_MAX = 200, FLAG_HISTORY = 10, ASK_TIMEOUT_S = 600;

export function readParts(dir = DEFAULT_DIR) {
  const parts = {};
  for (const f of DATA_FILES) { const p = path.join(dir, `${f}.json`); if (fs.existsSync(p)) parts[f] = JSON.parse(fs.readFileSync(p, 'utf8')); }
  return parts;
}
export function newOfficePol() {
  return { v: 1, rep: {}, riskPolicy: 'avoid', warCover: 'auto', defaultRegistry: null, records: [], lockouts: [], designated: {}, exposure: [],
    calls: [], clearance: {}, clearanceFrom: {}, licences: {}, pending: null, cover: {}, coverSkip: {}, premiums: [], guards: {}, claims: [],
    repDay: {}, acc: {}, lastDaily: 0 };
}
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const num = (x, d = 0) => (Number.isFinite(x) ? x : d);
const clampRep = (n) => Math.max(POL.REP.min, Math.min(POL.REP.max, Math.round(n)));

/** office.pol defaults for old saves; wrong types are reset, unknown country codes in rep dropped (§6.5). */
export function healOfficePol(pol, countries = null) {
  const d = newOfficePol(), o = isObj(pol) ? pol : {};
  const out = { ...d };
  for (const k of ['rep', 'designated', 'clearance', 'clearanceFrom', 'licences', 'cover', 'coverSkip', 'guards', 'repDay', 'acc']) out[k] = isObj(o[k]) ? o[k] : d[k];
  for (const k of ['records', 'lockouts', 'exposure', 'calls', 'premiums', 'claims']) out[k] = Array.isArray(o[k]) ? o[k] : d[k];
  out.riskPolicy = RISK_POLICIES.includes(o.riskPolicy) ? o.riskPolicy : 'avoid';
  out.warCover = o.warCover === 'ask' ? 'ask' : 'auto';
  out.defaultRegistry = typeof o.defaultRegistry === 'string' ? o.defaultRegistry : null;
  out.pending = isObj(o.pending) && typeof o.pending.harbor === 'string' && Number.isFinite(o.pending.readyAt) ? o.pending : null;
  out.lastDaily = num(o.lastDaily, 0);
  const rep = {};
  for (const [cc, n] of Object.entries(out.rep)) if (/^[A-Z]{2}$/.test(cc) && Number.isFinite(n) && (!countries || countries[cc])) rep[cc] = clampRep(n);
  out.rep = rep;
  return out;
}
/** Vessel politics fields for old saves (grandfathered: flag = home country, national register). */
export function healVesselPol(v, homeCc, simTime) {
  if (!v || typeof v !== 'object') return v;
  const year = new Date(simTime * 1000).getUTCFullYear();
  if (!isObj(v.flag) || !/^[A-Z]{2}$/.test(v.flag.cc || '')) v.flag = { cc: homeCc || 'XX', registry: `national:${homeCc || 'XX'}`, since: 0 };
  if (!Array.isArray(v.flagWas)) v.flagWas = [];
  if (!Number.isFinite(v.built)) { const age = Math.max(0, Math.min(30, Math.round((100 - num(v.cond, 100)) / POL.AGE_YEARS_PER_COND))); v.built = year - age; }
  if (typeof v.builtIn !== 'string') v.builtIn = 'XX';
  if (!isObj(v.psc)) v.psc = { last: {}, detentions: [] };
  if (!isObj(v.psc.last)) v.psc.last = {};
  if (!Array.isArray(v.psc.detentions)) v.psc.detentions = [];
  if (v.held !== null && !(isObj(v.held) && Number.isFinite(v.held.until))) v.held = null;
  if (typeof v.scrubber !== 'boolean') v.scrubber = false;
  if (v.reflag != null && !(isObj(v.reflag) && typeof v.reflag.registry === 'string')) v.reflag = null;
  for (const c of v.cargo || []) if (c && c.origin === undefined) c.origin = null;
  return v;
}

export class Politics {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = opts;
    this.harbors = opts.harbors || HARBORS;
    this.hmap = new Map(this.harbors.map((h) => [h.id, h]));
    this.ds = opts.dataset || loadDataset({ ...readParts(opts.dir || DEFAULT_DIR), harbors: this.harbors });
    this.rt = new Map();          // vessel key → { inAreas: Set, ask: {}, offCorr: false }
    this.riskCache = new Map();
    this.log = opts.log || game?.log || (() => {});
    this.log(`[politics] dataset ${this.ds.meta.version} (valid as of ${this.ds.meta.validAsOf}): ${this.ds.areas.length} areas, ${this.ds.measures.length} measures`);
  }
  get now() { return this.game.simTime; }
  get version() { return this.ds.meta.version; }
  rnd() { return this.game.rnd(); }
  harborById(id) { return this.hmap.get(id) || null; }
  /** The client subset for /api/politics (everything except trade.json) and its ETag. */
  clientPayload() {
    if (!this._client) {
      const dir = this.opts.dir || DEFAULT_DIR, parts = this.opts.dataset ? this.ds : readParts(dir);
      const body = {}; for (const k of CLIENT_KEYS) body[k] = parts[k];
      this._client = { etag: `"pol-${this.version}"`, json: JSON.stringify(body) };
    }
    return this._client;
  }

  // ------------------------------------------------------------------------------------------ access helpers
  ownerOf(p) { return p?.isActor ? p.owner || null : p; }
  officeOf(p) { return this.ownerOf(p)?.office || null; }
  vesselOf(p) {
    if (this.opts.vesselOf) return this.opts.vesselOf(p);
    if (p?.isActor) return p.vessel || p;
    return (Array.isArray(p?.fleet) && p.fleet.find((x) => x.id === p.aboard)) || p;
  }
  vesselsOf(p) { const o = this.ownerOf(p); return Array.isArray(o?.fleet) && o.fleet.length ? o.fleet : [this.vesselOf(p)]; }
  vkey(v, p) { return v?.id || p?.id || 'p'; }
  polOf(p) {
    const o = this.officeOf(p) || (this.ownerOf(p) ? (this.ownerOf(p).office = {}) : null);
    if (!o) return newOfficePol();
    if (!o.pol || o.pol.v !== 1) o.pol = healOfficePol(o.pol, this.ds.countries);
    return o.pol;
  }
  homeCc(p) { return this.harborById(this.officeOf(p)?.home)?.country || null; }
  vview(v) { return { cls: v?.ship?.cls || v?.cls || 'coaster', cond: num(v?.cond, 100), built: v?.built, builtIn: v?.builtIn, psc: v?.psc, pscDetentions: v?.psc?.detentions || [], ship: v?.ship }; }
  ctxOf(p, v = this.vesselOf(p), over = {}) {
    const pol = this.polOf(p), homeCc = over.home ?? this.homeCc(p);
    healVesselPol(v, this.homeCc(p), this.now);
    const vid = this.vkey(v, p), t = this.now;
    const clearance = {};
    for (const [hid, until] of Object.entries(pol.clearance)) if ((pol.clearanceFrom[hid] ?? 0) <= t) clearance[hid] = until;
    return makeCtx(this.ds, {
      home: homeCc, flag: v.flag?.cc, flagWas: (v.flagWas || []).map((f) => ({ cc: f.cc, from: f.from, until: f.until })),
      rep: pol.rep, designated: pol.designated, exposure: pol.exposure, lockouts: pol.lockouts,
      calls: pol.calls.filter((c) => c.v === vid), clearance, licences: pol.licences, cargo: v.cargo || [], simTime: t,
    });
  }
  rtOf(key) { let r = this.rt.get(key); if (!r) this.rt.set(key, r = { inAreas: new Set(), ask: {}, offCorr: false }); return r; }
  say(p, kind, text, v = null) {
    const owner = this.ownerOf(p);
    if (p?.isActor && this.game.fleet?.tell && owner) return this.game.fleet.tell(owner, kind, text, v);
    this.game.event?.(owner || p, kind, text);
  }
  /** Money out (amount > 0) or in (amount < 0), through the fleet ledger when there is one. */
  charge(p, amount, cat, v = null) {
    const owner = this.ownerOf(p), amt = Math.round(amount);
    if (!owner || !amt) return 0;
    if (this.game.fleet?.book && owner.office) { try { this.game.fleet.book(owner, v?.id || '_', cat, -amt); return amt; } catch { /* fall through */ } }
    owner.money = num(owner.money) - amt;
    return amt;
  }
  /** Fractional costs (crew bonus, ECA surcharge, tonnage tax) collect until a whole credit is due. */
  accrue(p, key, amount, cat, v) {
    const pol = this.polOf(p); pol.acc[key] = num(pol.acc[key]) + amount;
    const whole = Math.floor(pol.acc[key]);
    if (whole >= 1) { pol.acc[key] -= whole; this.charge(p, whole, cat, v); }
    return whole;
  }
  record(p, kind, text, extra = {}) {
    const pol = this.polOf(p);
    pol.records.push({ t: Math.floor(this.now), kind, text, ...extra });
    if (pol.records.length > RECORDS_MAX) pol.records.splice(0, pol.records.length - RECORDS_MAX);
  }
  repOf(office, cc) { return num(office?.pol?.rep?.[cc], 0); }
  bumpRep(p, cc, n, why = '') {
    if (!cc || !n) return 0;
    const pol = this.polOf(p), before = num(pol.rep[cc]);
    pol.rep[cc] = clampRep(before + n);
    return pol.rep[cc] - before;
  }
  shipName(p, v) { return v?.name || p?.name || 'Your ship'; }
  where(v) { const s = v?.ship; return s ? `at ${s.lat.toFixed(2)}°, ${s.lon.toFixed(2)}°` : ''; }

  // ------------------------------------------------------------------------------------------ migration (H16)
  migrate(p) {
    const owner = this.ownerOf(p); if (!owner) return;
    if (owner.office) owner.office.pol = healOfficePol(owner.office.pol, this.ds.countries);
    const cc = this.homeCc(p);
    for (const v of this.vesselsOf(p)) healVesselPol(v, cc, this.now);
    for (const j of [...(owner.jobs || []), ...this.vesselsOf(p).flatMap((v) => v.jobs || [])]) if (j && j.pol !== undefined && !isObj(j.pol)) delete j.pol;
  }
  healOfficePol(pol) { return healOfficePol(pol, this.ds.countries); }
  healVesselPol(v, homeCc) { return healVesselPol(v, homeCc, this.now); }
  /** A new ship: the company's default registry (or the home country's national register, else Panama). */
  newVesselFlag(p, v, { builtIn = null } = {}) {
    const pol = this.polOf(p), cc = this.homeCc(p);
    let reg = pol.defaultRegistry && registryOf(this.ds, pol.defaultRegistry, cc);
    if (!reg || !registryOwnerOk(this.ds, reg, cc)) { const nat = registryOf(this.ds, this.ds.countries[cc]?.register || `national:${cc}`, cc); reg = nat && registryOwnerOk(this.ds, nat, cc) ? nat : registryOf(this.ds, 'pa', cc); }
    v.flag = { cc: reg?.flag || cc, registry: reg?.id || `national:${cc}`, since: Math.floor(this.now) };
    v.flagWas = []; v.built = new Date(this.now * 1000).getUTCFullYear(); v.builtIn = builtIn || 'XX';
    v.psc = { last: {}, detentions: [] }; v.held = null; v.scrubber = !!v.scrubber;
    return v.flag;
  }

  // ------------------------------------------------------------------------------------------ port entry (H8) and hold (H10)
  entryCheck(p, harbor) {
    const h = typeof harbor === 'string' ? this.harborById(harbor) : harbor, v = this.vesselOf(p);
    const e = entryCheck(this.ds, this.ctxOf(p, v), h, this.vview(v));
    if (e.ok) return { refuse: false, needs: e.needs || null, corridor: e.corridor || null };
    this.record(p, 'refused', e.refuse.text, { harbor: h.id, vid: v?.id || null });
    return { refuse: true, text: e.refuse.text, needs: e.needs || null, reason: e.refuse };
  }
  canUndock(p) { return this.heldText(this.vesselOf(p)); }
  /** Why this vessel may not sail now (PSC detention, coastal-state detention, hijack hold), or null. */
  heldText(v) {
    const h = v?.held;
    if (!h) return null;
    if (h.why === 'psc' && (num(v.cond, 100) < (h.cond ?? POL.PSC_RELEASE_COND) || this.now < h.until)) return `Detained by port state control: repair the hull to ${h.cond ?? POL.PSC_RELEASE_COND} % (now ${Math.round(num(v.cond, 100))} %)${this.now < h.until ? ' and wait for the inspector' : ''}.`;
    if (this.now < h.until) return `Held ${h.why === 'detention' ? 'by coastal state authorities' : 'in port'} — expected release in ${Math.max(1, Math.ceil((h.until - this.now) / 3600))} h.`;
    return null;
  }
  requestClearance(p, hid) {
    const h = this.harborById(hid), e = this.ds.ports[hid]?.entry, pol = this.polOf(p);
    if (!h || !e?.clearance) return { ok: false, text: 'No clearance needed there.' };
    const ctx = this.ctxOf(p);
    if (e.deniedWhen && matches(e.deniedWhen, ctx)) return { ok: false, text: fill(TEMPLATES.refusal, { harbour: h.name, measureText: 'entry denied for this vessel', srcShort: srcShort(this.ds, e.src) }) };
    const from = this.now + (e.clearanceH ?? POL.CLEARANCE_H) * 3600;
    pol.clearanceFrom[hid] = from; pol.clearance[hid] = from + (e.validH ?? POL.CLEARANCE_VALID_H) * 3600;
    return { ok: true, from, until: pol.clearance[hid], text: `Clearance for ${h.name} requested: issued in ${e.clearanceH ?? POL.CLEARANCE_H} h, valid ${e.validH ?? POL.CLEARANCE_VALID_H} h.` };
  }

  // ------------------------------------------------------------------------------------------ docked (H9)
  priceOf(h, good) { return num(this.game.harbors?.[h.id]?.market?.[good], GOODS[good]?.base || 0); }
  onDock(p, harbor) {
    const h = typeof harbor === 'string' ? this.harborById(harbor) : harbor, v = this.vesselOf(p), pol = this.polOf(p), t = this.now;
    const out = { seized: [], designated: null, psc: null, incident: null };
    if (!h || !v) return out;
    const vid = this.vkey(v, p);
    pol.calls.push({ v: vid, cc: h.country, h: h.id, at: Math.floor(t), trade: (v.cargo || []).some((c) => c.qty > 0) || (v.jobs || []).length > 0 });
    if (pol.calls.length > CALLS_MAX) pol.calls.splice(0, pol.calls.length - CALLS_MAX);
    this.rtOf(vid).inAreas.clear();
    // 1. seizure on entry: cargo the port's territory bans by origin (level 2)
    for (const c of [...(v.cargo || [])]) {
      if (c.jobId || !c.origin || !(c.qty > 0)) continue;
      const m = this.ds.measures.find((m) => isActive(m, t) && m.kind === 'import_ban' && m.scope?.includes('territorial') && (!m.goods || m.goods.includes(c.good)) && m.origin?.includes(c.origin) && inTerritory(this.ds, m.authority, h.country));
      if (m) out.seized.push(this.seize(p, v, h, c, m));
    }
    // 2. secondary exposure → designation roll, once per exposure, at that authority's ports (level 3)
    for (const x of pol.exposure) {
      if (x.rolled || !(x.until > t) || !inTerritory(this.ds, x.auth, h.country)) continue;
      x.rolled = true;
      if (this.rnd() < POL.DESIGNATION_P) {
        pol.designated[x.auth] = t + scaledS(POL.DESIGNATION_DAYS);
        const m = this.ds.measures.find((mm) => mm.id === x.measureId) || { src: [], asOf: null, text: 'secondary sanctions' };
        for (const c of [...(v.cargo || [])]) if (!c.jobId && c.good === x.good && c.origin === x.origin) out.seized.push(this.seize(p, v, h, c, m));
        out.designated = x.auth;
        const txt = `Your company was designated by ${x.auth} authorities (${m.text || m.id}). Refused entry at ${x.auth} ports until ${new Date(pol.designated[x.auth] * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
        this.record(p, 'designation', txt, { auth: x.auth }); this.say(p, 'law', txt, v);
      }
    }
    // 3. port state control
    const regId = pscRegimeOf(this.ds, h);
    if (regId) {
      const ctx = this.ctxOf(p, v), pc = pscChance(this.ds, regId, this.vview(v), ctx, t, h.country);
      out.psc = { regime: regId, ...pc, inspected: false, detained: false };
      if (pc.pInspect > 0 && this.rnd() < pc.pInspect) {
        out.psc.inspected = true; v.psc.last[regId] = Math.floor(t);
        if (this.rnd() < pc.pDetain) { out.psc.detained = true; this.pscDetain(p, v, h, regId); }
        else this.say(p, 'law', `Port state control (${this.ds.psc.regimes[regId].name}) inspected ${this.shipName(p, v)} at ${h.name}: no detainable deficiencies.`, v);
      }
    }
    // 4. port incident (tier-4 ports)
    const pi = this.ds.ports[h.id]?.portIncident;
    if (pi?.pCall > 0 && this.rnd() < pi.pCall) {
      const a = areasAt(this.ds, h.lat, h.lon, ['war_risk'], t)[0];
      out.incident = this.incident(p, v, a || { id: null, mix: { projectile: 1 } }, pickShare((a || {}).mix || { projectile: 1 }, this.rnd()), `at ${h.name}`);
    }
    return out;
  }
  seize(p, v, h, c, m) {
    const value = Math.round(c.qty * this.priceOf(h, c.good)), fine = Math.max(POL.SEIZE_FINE_MIN, POL.SEIZE_FINE_MULT * value);
    v.cargo = v.cargo.filter((x) => x !== c);
    if (p !== v && Array.isArray(p.cargo) && p.cargo !== v.cargo) p.cargo = p.cargo.filter((x) => x !== c);
    const owner = this.ownerOf(p), canPay = num(owner?.money) >= fine;
    if (canPay) this.charge(p, fine, 'fees', v); else if (this.game.impound) this.game.impound(p, `${h.name} customs`, fine); else this.charge(p, fine, 'fees', v);
    this.bumpRep(p, h.country, POL.REP.seizure, 'seizure');
    const txt = fill(TEMPLATES.seizure, { harbour: h.name, qty: Math.round(c.qty), good: GOODS[c.good]?.name || c.good, origin: c.origin, measureText: m.text || m.id, srcShort: srcShort(this.ds, m.src), asOf: fmtDate(m.asOf), fine: fine.toLocaleString('en-US') });
    this.record(p, 'seizure', txt, { harbor: h.id, good: c.good, fine });
    this.say(p, 'law', txt, v);
    return { good: c.good, qty: c.qty, origin: c.origin, value, fine, measureId: m.id };
  }
  pscDetain(p, v, h, regId) {
    const reg = this.ds.psc.regimes[regId];
    v.held = { until: this.now + POL.PSC_MIN_HOLD_H * 3600, why: 'psc', cond: POL.PSC_RELEASE_COND, regime: regId, harbor: h.id };
    v.psc.detentions.push({ regime: regId, at: Math.floor(this.now), harbor: h.id });
    if (v.psc.detentions.length > 20) v.psc.detentions.splice(0, v.psc.detentions.length - 20);
    this.charge(p, POL.PSC_FEE, 'fees', v);
    this.bumpRep(p, h.country, POL.REP.detention, 'psc');
    for (const cc of reg.members || []) if (cc !== h.country) this.bumpRep(p, cc, POL.REP.detentionRegime, 'psc');
    const txt = fill(TEMPLATES.psc, { ship: this.shipName(p, v), harbour: h.name, regime: reg.name, cond: POL.PSC_RELEASE_COND });
    this.record(p, 'detention', `${txt} Fee ${POL.PSC_FEE} cr.`, { harbor: h.id, regime: regId });
    this.say(p, 'law', `${txt} Fee ${POL.PSC_FEE.toLocaleString('en-US')} cr.`, v);
  }

  // ------------------------------------------------------------------------------------------ incidents (crew always safe, P5)
  incident(p, v, area, kind, where = this.where(v)) {
    const pol = this.polOf(p), ship = this.shipName(p, v), vid = this.vkey(v, p), covered = (pol.cover[`${vid}|${area?.id}`] || 0) > this.now;
    if (kind === 'detention') {
      const [a, b] = POL.DETENTION_H, h = Math.round(a + this.rnd() * (b - a));
      v.held = { until: this.now + h * 3600, why: 'detention', areaId: area?.id || null };
      const txt = fill(TEMPLATES.detention, { ship, where, h });
      this.record(p, 'detention', txt, { areaId: area?.id || null }); this.say(p, 'risk', txt, v);
      return { kind, outcome: 'detention', hours: h, text: txt };
    }
    const outcome = incidentOutcome(this.rnd());
    if (outcome === 'loss') {
      const txt = fill(TEMPLATES.loss, { ship, where });
      if (covered) this.charge(p, -hullValue(this.vview(v).cls, num(v.cond, 100)), 'income', v);
      this.record(p, 'loss', txt, { areaId: area?.id || null }); this.say(p, 'risk', txt, v);
      this.game.sink?.(p, 'war_loss', txt);
      return { kind, outcome, text: txt, covered };
    }
    const n = outcome === 'minor' ? POL.OUTCOME.minor[1] : POL.OUTCOME.major[1];
    v.cond = Math.max(0, num(v.cond, 100) - n);
    let lost = 0;
    if (outcome === 'major') for (const c of v.cargo || []) { const k = c.qty * POL.MAJOR_CARGO_LOSS; c.qty = Math.round((c.qty - k) * 10) / 10; lost += k; }
    if (outcome === 'major') v.cargo = (v.cargo || []).filter((c) => c.qty > 0);
    if (covered) pol.claims.push({ v: vid, points: n, until: Math.floor(this.now + 30 * 86400) });
    const txt = fill(kind === 'mine' ? TEMPLATES.mine : TEMPLATES.projectile, { ship, where, n });
    this.record(p, 'incident', txt, { areaId: area?.id || null, outcome });
    this.say(p, 'risk', txt, v);
    return { kind, outcome, hull: n, cargoLost: Math.round(lost * 10) / 10, covered, text: txt };
  }
  /** Hull points covered by war cover that a repair may credit (call from the yard; consumes the claim). */
  repairCredit(p, v = this.vesselOf(p)) {
    const pol = this.polOf(p), vid = this.vkey(v, p);
    let pts = 0; pol.claims = pol.claims.filter((c) => { if (c.v === vid && c.until > this.now) { pts += c.points; return false; } return c.until > this.now; });
    return pts;
  }

  // ------------------------------------------------------------------------------------------ at sea (H11)
  coverKey(v, p, areaId) { return `${this.vkey(v, p)}|${areaId}`; }
  buyCover(p, v, a) {
    const pol = this.polOf(p), prem = warPremium(a, this.vview(v).cls, num(v.cond, 100));
    this.charge(p, prem, 'fees', v);
    pol.cover[this.coverKey(v, p, a.id)] = this.now + POL.COVER_MAX_H * 3600;
    delete pol.coverSkip[this.coverKey(v, p, a.id)];
    pol.premiums.push({ v: this.vkey(v, p), areaId: a.id, cr: prem, at: Math.floor(this.now), refunded: false });
    if (pol.premiums.length > 100) pol.premiums.splice(0, pol.premiums.length - 100);
    this.say(p, 'risk', `${fill(TEMPLATES.premium, { areaName: a.name, srcShort: srcShort(this.ds, a.src) })}: ${prem.toLocaleString('en-US')} cr.`, v);
    return prem;
  }
  stepSea(p, hrs, burnT = 0, { underway = true } = {}) {
    const v = this.vesselOf(p); if (!v?.ship || !(hrs > 0)) return { entered: [], exited: [] };
    const t = this.now, key = this.vkey(v, p), rt = this.rtOf(key), pol = this.polOf(p), C = SHIP_CLASSES[v.ship.cls] || SHIP_CLASSES.coaster;
    const here = areasAt(this.ds, v.ship.lat, v.ship.lon, null, t), ids = new Set(here.map((a) => a.id));
    const out = { entered: [], exited: [], incidents: [] };
    for (const id of rt.inAreas) if (!ids.has(id)) { out.exited.push(id); delete pol.cover[`${key}|${id}`]; delete rt.ask[id]; }
    let ctx = null; const ctxNow = () => (ctx ||= this.ctxOf(p, v));
    for (const a of here) {
      const fresh = !rt.inAreas.has(a.id);
      if (fresh) out.entered.push(a.id);
      if (a.kind === 'war_risk') {
        const ck = `${key}|${a.id}`, covered = (pol.cover[ck] || 0) > t, skipped = !!pol.coverSkip[ck];
        if (!covered && !skipped) {
          if (pol.warCover === 'auto' || p.isActor) this.buyCover(p, v, a);
          else if (!rt.ask[a.id]) { rt.ask[a.id] = t; this.game.send?.(this.ownerOf(p), { t: 'pol_cover_ask', areaId: a.id, name: a.name, premium: warPremium(a, C.id, num(v.cond, 100)) }); }
          else if (t - rt.ask[a.id] >= ASK_TIMEOUT_S) { pol.coverSkip[ck] = true; this.say(p, 'risk', `No answer: ${this.shipName(p, v)} sails on without war cover in ${a.name}.`, v); }
        }
        if (fresh) this.say(p, 'risk', fill(TEMPLATES.areaChip, { areaName: a.name, srcShort: srcShort(this.ds, a.src), asOf: fmtDate(a.asOf) }), v);
        let mul = a.profile && matches(a.profile.when, ctxNow()) ? a.profile.mul || 1 : 1;
        const corr = this.corridorFor(a);
        let pDay = pDayOf(a) * mul;
        if (corr && this.offCorridor(v, corr)) { const mine = a.mix?.mine || 0; pDay *= mine * POL.OFF_CORRIDOR_MINE_MUL + (1 - mine); if (!rt.offCorr) { rt.offCorr = true; this.say(p, 'risk', `Off the corridor — mine risk higher (advisory ${srcShort(this.ds, corr.src)}).`, v); } } else rt.offCorr = false;
        const pH = 1 - Math.pow(1 - Math.min(1, pDay), hrs / 24);
        if (this.rnd() < pH) { out.incidents.push(this.incident(p, v, a, pickShare(a.mix || { projectile: 1 }, this.rnd()))); if (!v.ship || num(v.cond, 1) <= 0) break; }
      } else if (a.kind === 'warlike' && underway && C.crewCost) {
        if (fresh) this.say(p, 'risk', fill(TEMPLATES.warlike, { asOf: fmtDate(a.asOf) }), v);
        this.accrue(p, `crew|${key}`, C.crewCost * ((a.crewPayMul || 2) - 1) * hrs, 'wages', v);
      } else if (a.kind === 'eca') {
        if (POL.ECA_ON && burnT > 0 && !v.scrubber && (a.sulphurPct ?? 1) <= 0.10) this.accrue(p, `eca|${key}`, burnT * ecaPerT(), 'fuel', v);
      } else if (a.kind === 'piracy' && underway) {
        const kn = Math.abs(num(v.ship.spd)), km = kn * 1.852 * hrs;
        const guards = (pol.guards[key]?.until || 0) > t && pol.guards[key]?.areaId === a.id;
        const pr = piracyChance(a.p100 || 0, km, { speedKn: kn, convoy: !!(this.ownerOf(p)?.convoyId), guards });
        if (pr > 0 && this.rnd() < pr) out.incidents.push(this.piracy(p, v, a, pickShare(a.kinds || { robbery: 1 }, this.rnd())));
      }
      for (const j of v.jobs || []) if (j?.pol?.mustAvoid?.includes(a.id) && !j.pol.breached) { j.pol.breached = true; this.say(p, 'risk', `${this.shipName(p, v)} entered ${a.name}, which the contract "${j.title}" says to avoid: pay halved on delivery.`, v); }
    }
    rt.inAreas = ids;
    return out;
  }
  corridorFor(area) {
    for (const c of this.ds.areas) if (c.kind === 'corridor' && isActive(c, this.now) && (c.to || []).some((hid) => { const h = this.harborById(hid); return h && areasAt(this.ds, h.lat, h.lon, ['war_risk']).some((x) => x.id === area.id); })) return c;
    return null;
  }
  offCorridor(v, corr) {
    const s = v.ship, line = corr.line || [];
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const [lo1, la1] = line[i - 1], [lo2, la2] = line[i];
      for (let k = 0; k <= 10; k++) { const f = k / 10; best = Math.min(best, haversine(s.lat, s.lon, la1 + (la2 - la1) * f, lo1 + (lo2 - lo1) * f) / 1000); }
    }
    return best > POL.OFF_CORRIDOR_KM;
  }
  piracy(p, v, a, kind, where = this.where(v)) {
    const ship = this.shipName(p, v), pol = this.polOf(p), covered = (pol.cover[this.coverKey(v, p, a.id)] || 0) > this.now;
    let txt;
    if (kind === 'robbery') { const cr = Math.min(POL.ROBBERY_MAX, Math.round(POL.ROBBERY_FRAC * Math.max(0, num(this.ownerOf(p)?.money)))); this.charge(p, cr, 'costs', v); txt = fill(TEMPLATES.robbery, { ship, where, cr }); }
    else if (kind === 'repelled') { v.cond = Math.max(0, num(v.cond, 100) - 3); txt = fill(TEMPLATES.repelled, { ship, where, n: 3 }); }
    else { v.held = { until: this.now + POL.HIJACK_H * 3600, why: 'hijack', areaId: a.id }; if (!covered) this.charge(p, Math.round(POL.HIJACK_COST_FRAC * hullValue(this.vview(v).cls, num(v.cond, 100))), 'costs', v); txt = fill(TEMPLATES.hijack, { ship, where, h: POL.HIJACK_H }); }
    this.record(p, 'piracy', txt, { areaId: a.id, kind }); this.say(p, 'risk', txt, v);
    return { kind, text: txt };
  }
  /** Crew wage multiplier at a position (IBF warlike areas) — for captained ships' wage rate. */
  crewPayMulAt(lat, lon) { const w = areasAt(this.ds, lat, lon, ['warlike'], this.now)[0]; return w ? w.crewPayMul || 2 : 1; }
  buyGuards(p, areaId, days) {
    const a = this.ds.areaById[areaId]; if (!a || a.kind !== 'piracy') return { ok: false, text: 'No piracy area by that name.' };
    const v = this.vesselOf(p), cost = guardsCost(days), pol = this.polOf(p);
    if (num(this.ownerOf(p)?.money) < cost) return { ok: false, text: `Guards cost ${cost.toLocaleString('en-US')} cr.` };
    this.charge(p, cost, 'costs', v);
    pol.guards[this.vkey(v, p)] = { areaId, until: this.now + Math.max(1, days) * 86400 * 2 };
    return { ok: true, cost };
  }

  // ------------------------------------------------------------------------------------------ express passage (H17)
  expressCheck(p, route) {
    const v = this.vesselOf(p), pts = route?.points || [], end = pts[pts.length - 1];
    if (end && areasAt(this.ds, end[0], end[1], ['war_risk'], this.now).some((a) => a.tier >= 3)) return { refuse: true, text: 'Express passage cannot end inside a listed area (tier 3 or 4). Pick a point outside it.' };
    const from = { lat: v.ship.lat, lon: v.ship.lon }, kn = (SHIP_CLASSES[v.ship.cls] || SHIP_CLASSES.coaster).maxKn * 0.85;
    const ex = routeExposure(this.ds, from, pts, kn, this.now), incidents = [];
    for (const x of ex.areas) {
      const a = this.ds.areaById[x.id]; if (a.kind !== 'war_risk') continue;
      if (!((this.polOf(p).cover[this.coverKey(v, p, a.id)] || 0) > this.now)) this.buyCover(p, v, a);
      if (this.rnd() < transitChance(pDayOf(a), x.km, kn)) incidents.push(this.incident(p, v, a, pickShare(a.mix || { projectile: 1 }, this.rnd()), `in ${a.name}`));
    }
    return { refuse: false, exposure: ex, incidents };
  }

  // ------------------------------------------------------------------------------------------ trade (H7) and contracts (H6, H12)
  stackOrigin(p, harbor, { caught = false } = {}) { return caught ? this.vesselOf(p)?.flag?.cc || this.homeCc(p) : (typeof harbor === 'string' ? this.harborById(harbor) : harbor)?.country || null; }
  onTrade(p, harbor, good, side, { origin = null, value = 0 } = {}) {
    const h = typeof harbor === 'string' ? this.harborById(harbor) : harbor, ctx = this.ctxOf(p);
    const r = tradeCheck(this.ds, ctx, { harbor: h, good, side, origin: side === 'buy' ? h.country : origin, value });
    if (!r.ok) { this.say(p, 'law', r.block.text); return { block: true, text: r.block.text, reason: r.block, warn: r.warn }; }
    if (side === 'buy') {
      const pol = this.polOf(p);
      for (const m of this.ds.measures) if (m.kind === 'secondary' && isActive(m, this.now) && (!m.goods || m.goods.includes(good)) && m.origin?.includes(h.country)) {
        pol.exposure.push({ auth: m.authority, measureId: m.id, good, origin: h.country, at: Math.floor(this.now), until: Math.floor(this.now + scaledS(POL.EXPOSURE_DAYS)), rolled: false });
        if (pol.exposure.length > 50) pol.exposure.shift();
      }
    }
    return { block: false, warn: r.warn, duty: r.duty || null };
  }
  onAccept(p, job, v = this.vesselOf(p)) {
    const jc = jobCheck(this.ds, this.ctxOf(p, v), job, this.vview(v));
    if (!jc.ok) return { block: true, text: jc.block.text, reason: jc.block };
    job.pol = { ...(isObj(job.pol) ? job.pol : {}), ver: this.version, acceptedAt: Math.floor(this.now) };
    if (jc.tags.cab) job.pol.cab = jc.tags.cab;
    return { block: false, warn: jc.warn, tags: jc.tags };
  }
  onPaid(p, j, late = false, harbor = null) {
    const pol = this.polOf(p), v = this.vesselOf(p), from = this.harborById(j.from), to = harbor || this.harborById(j.to), day = dateOf(this.now);
    const out = { payMul: 1, refund: 0, rep: {} };
    const bump = (cc, n) => { if (cc && n) out.rep[cc] = (out.rep[cc] || 0) + this.bumpRep(p, cc, n); };
    if (j.pol?.mustAvoid && j.pol.breached) { out.payMul = 0.5; bump(from?.country, POL.REP.breach); }
    if (late) bump(to?.country, POL.REP.late);
    else for (const cc of new Set([from?.country, to?.country].filter(Boolean))) {
      const k = `${cc}:${day}`; if (num(pol.repDay[k]) < POL.REP.deliverCapDay) { pol.repDay[k] = num(pol.repDay[k]) + 1; bump(cc, POL.REP.deliver); }
    }
    if (j.type === 'aid') bump(to?.country, POL.REP.humanitarian);
    if (j.type === 'state') bump(from?.country, POL.REP.charter);
    if ((j.pol?.tier || 0) > 0) {
      const vid = this.vkey(v, p), since = j.pol.acceptedAt ?? 0;
      for (const x of pol.premiums) if (x.v === vid && !x.refunded && x.at >= since) { x.refunded = true; out.refund += x.cr; }
      if (out.refund > 0) { this.charge(p, -out.refund, 'income', v); this.say(p, 'info', `War premium refunded by the shipper: +${out.refund.toLocaleString('en-US')} cr.`, v); }
    }
    return out;
  }
  /** §4.17: wind-down and frustration of accepted jobs when the data changes. */
  reconcile(p) {
    const actions = [], t = this.now;
    for (const v of this.vesselsOf(p)) {
      const jobs = v.jobs || []; if (!jobs.length) continue;
      const ctx = this.ctxOf(p, v);
      for (const j of [...jobs]) {
        const to = this.harborById(j.to);
        const closed = to && portStatus(this.ds, to).value === 'closed';
        if (closed) { actions.push(this.frustrate(p, v, j, 'the destination port is closed')); continue; }
        if (!isObj(j.pol)) continue;                       // grandfathered: only closures apply
        const jc = jobCheck(this.ds, ctx, j, this.vview(v));
        if (jc.ok) { if (j.pol.windDownUntil) delete j.pol.windDownUntil; continue; }
        const m = this.ds.measures.find((x) => x.id === jc.block.measureId), fromS = m?.from ? dateToS(m.from) : 0;
        if (m && num(j.pol.acceptedAt, 0) < fromS) {
          const until = fromS + (m.windDownDays ?? POL.WIND_DOWN_DAYS) * POL.DAY_TO_H * 3600;
          if (!j.pol.windDownUntil) { j.pol.windDownUntil = until; actions.push({ jobId: j.id, action: 'wind_down', until }); this.say(p, 'law', `Wind-down until ${new Date(until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${j.title} (${jc.block.text})`, v); }
          if (t > j.pol.windDownUntil) actions.push(this.frustrate(p, v, j, jc.block.text));
        } else actions.push(this.frustrate(p, v, j, jc.block.text));
      }
    }
    return actions;
  }
  frustrate(p, v, j, why) {
    const pay = Math.round(num(j.pay) * POL.FRUSTRATION_PAY);
    v.jobs = (v.jobs || []).filter((x) => x !== j);
    v.cargo = (v.cargo || []).filter((c) => c.jobId !== j.id);
    const owner = this.ownerOf(p);
    if (owner && owner !== v && Array.isArray(owner.jobs) && owner.jobs !== v.jobs) owner.jobs = owner.jobs.filter((x) => x.id !== j.id);
    if (pay > 0) this.charge(p, -pay, 'income', v);
    const txt = `Contract cancelled without fee: ${j.title} — ${why}. Frustration payment ${pay.toLocaleString('en-US')} cr.`;
    this.record(p, 'frustrated', txt, { jobId: j.id }); this.say(p, 'law', txt, v);
    return { jobId: j.id, action: 'cancelled', pay };
  }

  // ------------------------------------------------------------------------------------------ economy hooks (H2–H5)
  riskOf(fromId, toId) {
    const k = `${fromId}|${toId}|${this.version}`;
    if (this.riskCache.has(k)) return this.riskCache.get(k);
    const a = this.harborById(fromId), b = this.harborById(toId);
    let res = { tier: 0, areas: [] };
    if (a && b) {
      const ex = routeExposure(this.ds, a, [[b.lat, b.lon]], 12, this.now);
      const ids = new Set(ex.areas.filter((x) => x.kind === 'war_risk' || x.kind === 'piracy').map((x) => x.id));
      for (const x of areasAt(this.ds, b.lat, b.lon, ['war_risk', 'piracy'], this.now)) ids.add(x.id);
      const tier = Math.max(0, ...[...ids].map((id) => this.ds.areaById[id]).filter((x) => x.kind === 'war_risk').map((x) => x.tier));
      res = { tier, areas: [...ids] };
    }
    if (this.riskCache.size > 20000) this.riskCache.clear();
    this.riskCache.set(k, res);
    return res;
  }
  tagJob(j) {
    if (!j || !j.from || !j.to) return j;
    const r = this.riskOf(j.from, j.to), a = this.harborById(j.from), b = this.harborById(j.to);
    j.pol = { ...(isObj(j.pol) ? j.pol : {}), tier: r.tier, areas: r.areas, cab: a && b ? cabotageOf(this.ds, a.country, b.country)?.cc || null : null, ver: this.version };
    return j;
  }
  destWeight(fromId, toId, good) {
    const a = this.harborById(fromId), b = this.harborById(toId); if (!a || !b) return 1;
    if (portStatus(this.ds, b).value === 'closed') return 0;
    if (this.ds.measures.some((m) => m.authority === 'UN' && isActive(m, this.now) && m.kind !== 'arms_embargo' && (!m.goods || m.goods.includes(good)) && ((m.origin || []).includes(a.country) || (m.to || []).includes(b.country)))) return 0;
    return destWeightFor(tradeShare(this.ds, a.country, b.country, good));
  }
  contrabandOk(from, dest, good) {
    const a = typeof from === 'string' ? this.harborById(from) : from, b = typeof dest === 'string' ? this.harborById(dest) : dest;
    if (!a || !b) return true;
    if (this.ds.countries[a.country]?.conflict || this.ds.countries[b.country]?.conflict) return false;
    if (this.riskOf(a.id, b.id).areas.some((id) => this.ds.areaById[id]?.kind === 'war_risk')) return false;
    if (this.ds.measures.some((m) => m.kind === 'arms_embargo' && m.authority === 'UN' && isActive(m, this.now) && (m.target === a.country || m.target === b.country))) return false;
    return true;
  }
  tradeProfile(cc, good) { return tradeProfileMul(this.ds.trade?.flows?.[cc]?.[good]); }
  jobEnvHooks() {
    return { destWeight: (f, t, g) => this.destWeight(f, t, g), riskOf: (f, t) => this.riskOf(f, t), contrabandOk: (f, d, g) => this.contrabandOk(f, d, g), tradeProfile: (cc, g) => this.tradeProfile(cc, g), payMul: (f, t) => 1 + (POL.RISK_PAY[this.riskOf(f, t).tier] || 0) };
  }

  // ------------------------------------------------------------------------------------------ captains (H19–H21)
  /** Refusal text for a hired captain under the office risk policy, or null. */
  captainCheck(p, job, policy = this.polOf(p).riskPolicy, v = this.vesselOf(p)) {
    const jc = jobCheck(this.ds, this.ctxOf(p, v), job, this.vview(v));
    if (!jc.ok) return jc.block.text;
    return riskPolicyRefusal(this.ds, job, policy, this.harborById(job.to));
  }
  avoidDiscs(policy, from, to, max = 8) { return avoidDiscs(this.ds, policy, from, to, max); }
  corridorWaypoints(toId) {
    const corr = this.ds.ports[toId]?.entry?.corridor, c = corr && this.ds.areaById[corr];
    return c?.line ? c.line.map(([lo, la]) => [la, lo]) : null;
  }
  /** Captain departure: entry rules at the destination; for 'accept' a clearance is requested automatically. */
  departureCheck(p, v, toId) {
    const h = this.harborById(toId); if (!h) return null;
    const e = entryCheck(this.ds, this.ctxOf(p, v), h, this.vview(v));
    if (e.ok) return null;
    if (e.needs === 'clearance') {
      if (this.polOf(p).riskPolicy === 'accept') { const r = this.requestClearance(p, toId); return r.ok ? { wait: true, until: r.from, text: `waiting for entry clearance at ${h.name}` } : { fail: true, text: r.text }; }
      return { fail: true, text: `${h.name} needs entry clearance — request it in the Rules tab` };
    }
    return { fail: true, text: e.refuse.text };
  }

  // ------------------------------------------------------------------------------------------ flags and home (H18)
  reflagOptions(p, v, homeCc = this.homeCc(p)) {
    const ids = [...Object.keys(this.ds.registries).filter((k) => k !== 'national'), `national:${homeCc}`];
    const age = vesselAge(v, this.now), cls = this.vview(v).cls, out = [];
    for (const id of ids) {
      const reg = registryOf(this.ds, id, homeCc); if (!reg) continue;
      const ownerOk = registryOwnerOk(this.ds, reg, homeCc), ageOk = !(reg.age?.maxYears != null && age > reg.age.maxYears);
      const survey = reg.age?.inspectOverYears != null && age > reg.age.inspectOverYears ? Math.round(hullBasis(cls) * 0.01) : 0;
      out.push({ id, name: reg.name, flag: reg.flag || homeCc, ok: ownerOk && ageOk, ownerOk, ageOk, cost: reflagCost(reg, cls) + survey, survey, hours: (reg.setupDays || 0) * POL.DAY_TO_H, src: reg.src || [] });
    }
    return out.sort((a, b) => (b.ok - a.ok) || a.cost - b.cost || a.hours - b.hours || a.id.localeCompare(b.id));
  }
  reflagStart(p, v, registry, { free = false } = {}) {
    if (!v) return { ok: false, text: 'No such ship.' };
    if (!(v.docked || Math.abs(num(v.ship?.spd)) < 0.5)) return { ok: false, text: 'Re-flag while docked or at anchor.' };
    if (v.held && (v.held.until > this.now || v.held.why === 'psc')) return { ok: false, text: 'A detained ship cannot change flag.' };
    if (Object.values(this.polOf(p).designated).some((u) => u > this.now)) return { ok: false, text: 'A designated company cannot change flags.' };
    const opt = this.reflagOptions(p, v).find((o) => o.id === registry);
    if (!opt) return { ok: false, text: 'Unknown registry.' };
    if (!opt.ok) return { ok: false, text: !opt.ownerOk ? `${opt.name}: your company does not meet the owner rule.` : `${opt.name}: the ship is too old for this register.` };
    if (!free) { if (num(this.ownerOf(p)?.money) < opt.cost) return { ok: false, text: `Re-flagging costs ${opt.cost.toLocaleString('en-US')} cr.` }; this.charge(p, opt.cost, 'fees', v); }
    v.reflag = { registry, readyAt: Math.floor(this.now + opt.hours * 3600) };
    if (opt.hours === 0) this.reflagComplete(p, v);
    return { ok: true, cost: opt.cost, readyAt: v.reflag?.readyAt ?? this.now };
  }
  reflagComplete(p, v) {
    const r = v.reflag; if (!r) return;
    const reg = registryOf(this.ds, r.registry, this.homeCc(p)), cc = reg?.flag || this.homeCc(p);
    if (v.flag?.cc && v.flag.cc !== cc) { v.flagWas.push({ cc: v.flag.cc, from: v.flag.since || 0, until: Math.floor(this.now) }); if (v.flagWas.length > FLAG_HISTORY) v.flagWas.splice(0, v.flagWas.length - FLAG_HISTORY); }
    v.flag = { cc, registry: r.registry, since: Math.floor(this.now) }; v.reflag = null;
    this.say(p, 'info', `${this.shipName(p, v)} now flies the flag of ${this.ds.countries[cc]?.name || cc} (${reg?.name || r.registry}).`, v);
  }
  homeMovePlan(p, h, { baseCost = 0 } = {}) {
    const v0 = this.vesselOf(p), before = this.ctxOf(p, v0), cc = h?.country, ds = this.ds;
    if (!h) return { allowed: 'Pick a harbour.' };
    const after = this.ctxOf(p, v0, { home: cc });
    const plan = {
      harbor: h.id, country: cc, followsBefore: [...before.homeFollows], followsAfter: [...new Set(ds.countries[cc]?.follows || ['UN'])],
      customsBefore: before.customs, customsAfter: ds.countries[cc]?.customs || cc,
      cabotage: { before: ds.countries[before.home]?.cabotage?.rule || 'nodata', after: ds.countries[cc]?.cabotage?.rule || 'nodata' },
      psc: ds.ports[h.id]?.psc ?? ds.countries[cc]?.psc ?? null, reflag: [], blocking: [], formationH: 0, cost: 0, allowed: true,
    };
    for (const v of this.vesselsOf(p)) {
      const reg = registryOf(ds, v.flag?.registry, before.home);
      if (reg && registryOwnerOk(ds, reg, cc)) continue;
      const best = this.reflagOptions(p, v, cc).find((o) => o.ok);
      plan.reflag.push({ vesselId: v.id || null, name: v.name || null, from: v.flag?.registry || null, to: best?.id || null, cost: best?.cost ?? null, hours: best?.hours ?? null });
    }
    for (const v of this.vesselsOf(p)) {
      const ctx = this.ctxOf(p, v, { home: cc });
      for (const j of v.jobs || []) { const jc = jobCheck(ds, ctx, j, this.vview(v)); if (!jc.ok) plan.blocking.push({ jobId: j.id, title: j.title, reason: jc.block.text }); }
    }
    const st = portStatus(ds, h);
    const e = entryCheck(ds, after, h, this.vview(v0), { ignoreClearance: true });
    const company = ds.countries[cc]?.company || {};
    plan.formationH = (company.formationDays ?? POL.FORMATION_DAYS_DEFAULT) * POL.DAY_TO_H;
    plan.costParts = { move: baseCost, formation: POL.FORMATION_FEE, reflag: plan.reflag.reduce((s, r) => s + (r.cost || 0), 0) };
    plan.cost = plan.costParts.move + plan.costParts.formation + plan.costParts.reflag;
    if (st.value === 'closed') plan.allowed = `${h.name} is closed to merchant shipping — a company cannot be based there.`;
    else if (!e.ok) plan.allowed = e.refuse.text;
    else if (company.local === 'local_majority' && !company.shippingException) plan.allowed = `${ds.countries[cc]?.name || cc} limits foreign ownership of companies (${srcShort(ds, company.src)}).`;
    else if (plan.reflag.some((r) => !r.to)) plan.allowed = 'A ship has no registry open to a company based there.';
    else if (plan.blocking.length) plan.allowed = 'Finish or abandon the contracts that the new country would not allow first.';
    else if (this.polOf(p).pending) plan.allowed = 'A move is already in progress.';
    return plan;
  }
  homeStart(p, h, { baseCost = 0 } = {}) {
    const plan = this.homeMovePlan(p, h, { baseCost });
    if (plan.allowed !== true) return { ok: false, text: plan.allowed, plan };
    if (num(this.ownerOf(p)?.money) < plan.cost) return { ok: false, text: `The move costs ${plan.cost.toLocaleString('en-US')} cr.`, plan };
    this.charge(p, plan.costParts.move + plan.costParts.formation, 'fees');
    for (const r of plan.reflag) { const v = this.vesselsOf(p).find((x) => (x.id || null) === r.vesselId); if (v) { this.charge(p, r.cost, 'fees', v); v.reflag = { registry: r.to, readyAt: Math.floor(this.now + plan.formationH * 3600 + r.hours * 3600), forMove: true }; } }
    this.polOf(p).pending = { harbor: h.id, readyAt: Math.floor(this.now + plan.formationH * 3600), fee: POL.FORMATION_FEE, startedAt: Math.floor(this.now) };
    this.say(p, 'info', `Company registration in ${this.ds.countries[h.country]?.name || h.country} started: ready in ${plan.formationH} h.`);
    return { ok: true, plan, readyAt: this.polOf(p).pending.readyAt };
  }
  homeCancel(p) {
    const pol = this.polOf(p); if (!pol.pending) return { ok: false, refund: 0 };
    const refund = Math.round((pol.pending.fee || POL.FORMATION_FEE) * 0.5);
    this.charge(p, -refund, 'income');
    for (const v of this.vesselsOf(p)) if (v.reflag?.forMove) v.reflag = null;
    pol.pending = null;
    this.say(p, 'info', `Company move cancelled; ${refund.toLocaleString('en-US')} cr of the formation fee refunded.`);
    return { ok: true, refund };
  }
  homeComplete(p) {
    const pol = this.polOf(p), o = this.officeOf(p), pend = pol.pending; if (!pend || !o) return false;
    const h = this.harborById(pend.harbor);
    o.home = h.id; o.homeSetAt = Math.floor(this.now); o.homeMoves = num(o.homeMoves) + 1; pol.pending = null;
    const f = this.ds.countries[h.country]?.follows || ['UN'];
    this.say(p, 'info', `Your company is now based at ${h.name}, ${this.ds.countries[h.country]?.name || h.country}. Measures followed: ${f.join(', ')}.`);
    return true;
  }

  // ------------------------------------------------------------------------------------------ ticks (H22)
  /** Cheap per-tick housekeeping: holds released, re-flags and a pending home move completed. */
  tick(p) {
    const pol = this.polOf(p), t = this.now;
    for (const v of this.vesselsOf(p)) {
      if (v.held && t >= v.held.until && (v.held.why !== 'psc' || num(v.cond, 100) >= (v.held.cond ?? POL.PSC_RELEASE_COND))) { const why = v.held.why; v.held = null; this.say(p, 'info', `${this.shipName(p, v)} released (${why === 'psc' ? 'port state control' : 'hold'} lifted). Crew safe.`, v); }
      if (v.reflag && t >= v.reflag.readyAt && !(v.reflag.forMove && pol.pending)) this.reflagComplete(p, v);
    }
    if (pol.pending && t >= pol.pending.readyAt) this.homeComplete(p);
  }
  dailyTick(p) {
    const pol = this.polOf(p), t = this.now, cc = this.homeCc(p);
    const days = pol.lastDaily ? Math.floor((t - pol.lastDaily) / 86400) : 1;
    if (days < 1) return { days: 0 };
    pol.lastDaily = pol.lastDaily ? pol.lastDaily + days * 86400 : t;
    let tax = 0, agent = 0;
    for (const v of this.vesselsOf(p)) {
      const reg = registryOf(this.ds, v.flag?.registry, cc); if (!reg) continue;
      const d = (SHIP_CLASSES[v.ship?.cls] || SHIP_CLASSES.coaster).displacement;
      tax += this.accrue(p, `tax|${this.vkey(v, p)}`, (reg.fees?.annualPerTCr || 0) * d / 365 * days, 'fees', v);
      if (reg.owner?.rule === 'any_with_agent' && reg.flag !== cc && reg.owner.agentCrDay) agent += this.charge(p, reg.owner.agentCrDay * days, 'fees', v);
    }
    const local = this.ds.countries[cc]?.company;
    if (local && ['local_agent', 'local_director'].includes(local.local)) agent += this.charge(p, (local.agentCrDay || POL.AGENT_CR_DAY) * days, 'fees');
    for (const [k, n] of Object.entries(pol.rep)) if (n < 0) pol.rep[k] = Math.min(0, n + days);
    for (const [a, u] of Object.entries(pol.designated)) if (!(u > t)) delete pol.designated[a];
    for (const [k, u] of Object.entries(pol.cover)) if (!(u > t)) delete pol.cover[k];
    for (const [k, u] of Object.entries(pol.clearance)) if (!(u > t)) { delete pol.clearance[k]; delete pol.clearanceFrom[k]; }
    for (const [k, g] of Object.entries(pol.guards)) if (!(g?.until > t)) delete pol.guards[k];
    pol.lockouts = pol.lockouts.filter((l) => l.until > t);
    pol.exposure = pol.exposure.filter((x) => x.until > t);
    pol.premiums = pol.premiums.filter((x) => t - x.at < 60 * 86400);
    pol.claims = pol.claims.filter((c) => c.until > t);
    const today = dateOf(t); for (const k of Object.keys(pol.repDay)) if (!k.endsWith(today)) delete pol.repDay[k];
    return { days, tax, agent };
  }

  // ------------------------------------------------------------------------------------------ views (H13, H14, H24, fleet)
  harbourPayload(p, harbor) {
    const h = typeof harbor === 'string' ? this.harborById(harbor) : harbor, v = this.vesselOf(p), ctx = this.ctxOf(p, v);
    const r = harbourRules(this.ds, ctx, h, this.vview(v));
    const pol = this.polOf(p);
    r.clearancePending = (pol.clearanceFrom[h.id] || 0) > this.now ? pol.clearanceFrom[h.id] : null;
    r.stale = isStale(this.ds.meta, this.now);
    return r;
  }
  youView(p) {
    const v = this.vesselOf(p), ctx = this.ctxOf(p, v), pol = this.polOf(p), key = this.vkey(v, p), cover = {};
    for (const [k, u] of Object.entries(pol.cover)) if (k.startsWith(`${key}|`) && u > this.now) cover[k.slice(key.length + 1)] = u;
    return { ctx: { home: ctx.home, follows: [...ctx.follows], flag: ctx.flag, customs: ctx.customs, rep: pol.rep }, inAreas: [...this.rtOf(key).inAreas], cover, held: v?.held || null, clearance: { ...ctx.clearance }, pending: pol.pending, version: this.version };
  }
  officeView(p) {
    const pol = this.polOf(p);
    return {
      riskPolicy: pol.riskPolicy, warCover: pol.warCover, defaultRegistry: pol.defaultRegistry,
      flags: this.vesselsOf(p).map((v) => ({ id: v.id || null, name: v.name || null, flag: v.flag || null, built: v.built ?? null, builtIn: v.builtIn ?? null, reflag: v.reflag || null, held: v.held || null })),
      rep: pol.rep, records: pol.records.slice(-20), lockouts: pol.lockouts, designated: pol.designated, pending: pol.pending,
      version: this.version, validAsOf: this.ds.meta.validAsOf, stale: isStale(this.ds.meta, this.now),
    };
  }
  bankFlags(office) {
    const pol = office?.pol, t = this.now, out = [];
    if (!pol) return out;
    for (const [a, u] of Object.entries(pol.designated || {})) if (u > t) out.push(`designated:${a}`);
    if ((pol.records || []).some((r) => r.kind === 'seizure' && t - r.t < 30 * 86400)) out.push('seizure_30d');
    const det = (pol.records || []).filter((r) => r.kind === 'detention' && t - r.t < 90 * 86400).length;
    if (det >= 3) out.push(`detentions_${det}`);
    return out;
  }
  riskCheck(p, args) { const v = this.vesselOf(p); return riskCheck(this.ds, this.ctxOf(p, v), { cls: this.vview(v).cls, cond: num(v.cond, 100), vessel: this.vview(v), ...args }); }

  // ------------------------------------------------------------------------------------------ actions (H15)
  onAction(p, m) {
    const pol = this.polOf(p), v = this.vesselOf(p), warn = (text) => { this.game.event?.(this.ownerOf(p), 'warn', text); return false; };
    switch (m?.action) {
      case 'pol_policy':
        if (m.riskPolicy != null) { if (!RISK_POLICIES.includes(m.riskPolicy)) return warn('Unknown risk policy.'); pol.riskPolicy = m.riskPolicy; }
        if (m.warCover != null) { if (!['auto', 'ask'].includes(m.warCover)) return warn('Unknown war cover setting.'); pol.warCover = m.warCover; }
        return true;
      case 'pol_cover': { const a = this.ds.areaById[m.areaId]; if (!a || a.kind !== 'war_risk') return warn('No listed area by that name.'); this.buyCover(p, v, a); return true; }
      case 'pol_cover_skip': { if (!this.ds.areaById[m.areaId]) return warn('No listed area by that name.'); pol.coverSkip[this.coverKey(v, p, m.areaId)] = true; return true; }
      case 'pol_guards': { const r = this.buyGuards(p, m.areaId, Math.max(1, Math.min(10, num(m.days, 1)))); return r.ok || warn(r.text); }
      case 'pol_clearance': { const r = this.requestClearance(p, m.harbor); this.game.event?.(this.ownerOf(p), r.ok ? 'info' : 'law', r.text); return r.ok; }
      case 'pol_licence': {
        const cb = this.ds.countries[m.cc]?.cabotage; if (cb?.rule !== 'licence') return warn('No coastal trading licence there.');
        if (num(this.ownerOf(p)?.money) < cb.licence.feeCr) return warn(`The licence costs ${cb.licence.feeCr.toLocaleString('en-US')} cr.`);
        this.charge(p, cb.licence.feeCr, 'fees'); pol.licences[m.cc] = this.now + cb.licence.days * POL.DAY_TO_H * 3600 + 30 * 86400; return true;
      }
      case 'pol_reflag': { const vv = this.vesselsOf(p).find((x) => x.id === m.vesselId) || (m.vesselId == null ? v : null); const r = this.reflagStart(p, vv, m.registry); return r.ok || warn(r.text); }
      case 'pol_home_plan': { const h = this.harborById(m.harbor); this.game.send?.(this.ownerOf(p), { t: 'pol_home_plan', plan: this.homeMovePlan(p, h, { baseCost: num(m.baseCost) }) }); return true; }
      case 'pol_home_start': { const h = this.harborById(m.harbor); const r = this.homeStart(p, h, { baseCost: num(m.baseCost) }); return r.ok || warn(r.text); }
      case 'pol_home_cancel': return this.homeCancel(p).ok || warn('No company move in progress.');
      default: return null;
    }
  }
}

/** Risk-policy refusal for a captain (§4.16), or null. Pure on the dataset. */
export function riskPolicyRefusal(ds, job, policy, toHarbor = null) {
  const areas = [...(job?.pol?.areas || [])];
  if (toHarbor) for (const a of areasAt(ds, toHarbor.lat, toHarbor.lon, ['war_risk', 'piracy'])) if (!areas.includes(a.id)) areas.push(a.id);
  const list = areas.map((id) => ds.areaById[id]).filter(Boolean);
  if (policy === 'avoid') {
    if (['corridor', 'evac'].includes(job?.type)) return "Your risk policy is 'avoid': no captain takes corridor or evacuation runs.";
    const a = list.find((x) => x.kind === 'war_risk' || x.kind === 'piracy');
    if (a) return `Your risk policy is 'avoid': no captain sails into ${a.name}.`;
  } else if (policy === 'cautious') {
    const a = list.find((x) => x.kind === 'war_risk' && x.tier >= 3);
    if (a) return `Your risk policy is 'cautious': no captain sails into ${a.name}.`;
  }
  return null;
}
