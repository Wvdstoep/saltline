// The shipyard server (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §4): newbuild orders with deposit and instalments,
// delays and liquidated damages, buyer default and cancellation, delivery (at the yard or home), stock hulls, the
// second-hand market with history and pre-purchase inspection, repaint and rename. One instance: `game.yard = new Yard(game)`.
//
// Wiring (phase 2, docs/SHIPS-LANEA-PHASE2.md): game.js sendHarbor adds `yard: this.yard.view(p, h)` (H2), the action
// switch routes the nine `yard_*` actions to `this.yard.action(p, m)` (H3), the tick calls `this.yard.tick(this.simTime)` (H4).
// Until then the class is fully usable on its own (test/yard-server.test.mjs drives it on a real Game).
//
// Money only moves through game.fleet.book / charge (ledger category 'ships' for hull money, 'fees' for inspections and
// repaints, 'storage' for a finished ship waiting at a full fleet). Politics (R3 yardCheck, newVesselFlag) is used when
// present and skipped when absent.
import crypto from 'node:crypto';
import * as POLI from '../shared/politics.js';
import { SIM } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';
import { FLEET, validShipName, defaultShipName } from '../shared/fleet.js';
import { RATES } from '../shared/rates.js';
import { HARBORS, harborById } from './harbors.js';
import { ECON } from './economy.js';
import * as captain from './captain.js';
import {
  YARD, YARDS, YARD_IDS, MODELS, CLASS_BY_CC, registerHarbors, parseVariant, classRow, yardById, localYard, canOrderAt, yardPrice, stockPrice,
  newOrder, isOpen, compactOrder, marketValue, jonesOk, noteFlagChange, makeListing, publicListing, inspectionReport, inspectFee, repaintCost,
  yardStorageFeePerDay, defaultLivery, validLivery, financing, SIZE_LISTINGS, seededRnd, healOrders, healShipsVessel, yardsFor, isSpecialist,
} from '../shared/ships/index.js';

export const YARD_ACTIONS = ['yard_order', 'yard_pay', 'yard_rush', 'yard_cancel', 'yard_deliver', 'yard_buy_stock', 'yard_inspect', 'yard_buy_used', 'yard_repaint', 'yard_rename'];
const ORDER_ID_RE = /^o[0-9a-z]{1,16}$/;
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const r1 = (v) => Math.round(v * 10) / 10;
const short = (name) => String(name || '').split(' (')[0].split(',')[0];
const KEY_TEXT = { contract: 'Contract signed', steel: 'Steel cut', keel: 'Keel laid', launch: 'Launched', delivery: 'Delivery' };
function berthRef(h, b, hdg) { return { harbor: h.id, id: b.id, name: b.name, hdg, lat: b.lat, lon: b.lon, depth: b.depth, length: b.length }; }

export class Yard {
  constructor(game, opts = {}) {
    this.game = game;
    registerHarbors(opts.harbors || HARBORS);
    this.lastTick = 0;
  }
  get now() { return Math.floor(this.game.simTime); }
  get fleet() { return this.game.fleet; }

  // ------------------------------------------------------------------------------------------------ helpers
  players() { return this.game.byId ? [...this.game.byId.values()] : [...(this.game.players?.values?.() || [])]; }
  ordersOf(p) { if (!p.office) return []; if (!Array.isArray(p.office.orders)) healOrders(p.office); return p.office.orders; }
  openOf(p) { return this.ordersOf(p).filter(isOpen); }
  /** Open orders of every company at one yard (each adds a month of backlog). */
  openAt(yardId) { let n = 0; for (const p of this.players()) for (const o of p.office?.orders || []) if (o.yard === yardId && isOpen(o)) n++; return n; }
  homeCc(p) { return harborById(p.office?.home)?.country || null; }
  /** Politics R3: (cc, yard) → { ok, block? }. Off (every yard allowed) until shared/politics.js exports yardCheck and the game runs politics. */
  yardCheckFor(p) {
    const pol = this.game.politics;
    if (!pol || typeof POLI.yardCheck !== 'function') return null;
    return (cc) => { try { return POLI.yardCheck(pol.ds, pol.ctxOf(p), cc); } catch { return { ok: true }; } };
  }
  say(p, kind, text) { if (this.fleet?.tell) this.fleet.tell(p, kind, text); else this.game.event?.(p, kind, text); }
  warn(p, text) { this.game.event?.(p, 'warn', text); return false; }
  pay(p, cr, cat = 'ships', vid = '_') {
    cr = Math.round(cr); if (!cr) return;
    if (this.fleet?.book) this.fleet.book(p, vid, cat, -cr); else p.money -= cr;
  }
  refund(p, cr, vid = '_') {
    cr = Math.round(cr); if (!(cr > 0)) return;
    if (this.fleet?.book) this.fleet.book(p, vid, 'ships', cr); else p.money += cr;
  }
  refresh(p) { if (this.fleet?.refresh) this.fleet.refresh(p); else this.fleet?.dirty?.(p); }
  newOrderId(p) {
    const taken = new Set(this.ordersOf(p).map((o) => o.id));
    let id; do { id = 'o' + parseInt(crypto.randomBytes(5).toString('hex'), 16).toString(36); } while (taken.has(id));
    return id;
  }
  hullNo(orderId) { return `HN ${1000 + Math.floor(seededRnd(`hull:${orderId}`)() * 9000)}`; }
  modelName(variant) { const pv = parseVariant(variant); return pv ? MODELS[pv.model].refName.split(' (')[0] : variant; }
  yardName(id) { return short(yardById(id)?.name || id); }

  // ------------------------------------------------------------------------------------------------ the harbour payload (H2)
  /** `harbor.yard` (§7.3). */
  view(p, h) {
    if (!h) return null;
    const here = YARD_IDS.filter((id) => YARDS[id].harbor === h.id), local = !!localYard(h);
    const docked = p.docked === h.id;
    const tradeIn = docked ? (p.fleet || []).filter((v) => this.tradeInWhy(p, v, h) === null).map((v) => ({ vesselId: v.id, name: v.name, cls: v.ship.cls, cr: marketValue(v, h.country, this.now) })) : [];
    return {
      here, local, localId: local ? `local:${h.id}` : null,
      stock: this.stockAt(h),
      used: this.listingsAt(h).map((l) => publicListing(l, this.reportFor(l, p))),
      orders: this.ordersOf(p).map((o) => ({ ...compactOrder(o, this.now), price: o.price, schedule: o.schedule, deliverTo: o.deliverTo, quote: this.deliveryQuote(p, o), rush: this.rushQuote(p, o) })),
      tradeIn, sellValue: tradeIn.find((t) => t.vesselId === p.aboard)?.cr ?? 0,
      openOrders: this.openOf(p).length, maxOpen: YARD.MAX_OPEN_ORDERS,
    };
  }
  /** Yard list for one design with prices, hours and politics blocks (for the configurator). */
  quote(p, variant, harborId = p.docked) { return yardsFor(variant, { harbor: harborId, openOrders: 0, yardCheck: this.yardCheckFor(p) || undefined }).map((y) => ({ ...y, finance: financing(y.yardId, y.price) })); }

  // ------------------------------------------------------------------------------------------------ actions (H3)
  action(p, m) {
    if (!m || typeof m !== 'object' || !YARD_ACTIONS.includes(m.action)) return false;
    if (this.fleet?.allow && !this.fleet.allow(p)) return this.warn(p, 'Too many shipyard requests — wait a moment.');
    if (!p.office) return this.warn(p, 'You need an office first.');
    let r;
    switch (m.action) {
      case 'yard_order': r = this.order(p, m); break;
      case 'yard_pay': r = this.payAction(p, m); break;
      case 'yard_rush': r = this.rush(p, m); break;
      case 'yard_cancel': r = this.cancel(p, m); break;
      case 'yard_deliver': r = this.deliverAction(p, m); break;
      case 'yard_buy_stock': r = this.buyStock(p, m); break;
      case 'yard_inspect': r = this.inspect(p, m); break;
      case 'yard_buy_used': r = this.buyUsed(p, m); break;
      case 'yard_repaint': r = this.repaint(p, m); break;
      case 'yard_rename': r = this.rename(p, m); break;
      default: r = false;
    }
    this.refresh(p);
    return r;
  }
  orderById(p, id) { return typeof id === 'string' && ORDER_ID_RE.test(id) ? this.ordersOf(p).find((o) => o.id === id) || null : null; }
  ownVessel(p, id) { return typeof id === 'string' ? (p.fleet || []).find((v) => v.id === id) || null : null; }

  /** null when vessel v can be traded in at harbour h now, else the reason. */
  tradeInWhy(p, v, h) {
    if (!v) return 'That is not your ship.';
    if (p.aboard === v.id) return 'Go aboard another ship to trade this one in.';
    if (v.docked !== h.id) return `${v.name} must be moored here.`;
    if (v.cargo?.length) return `Unload ${v.name} first.`;
    if (v.jobs?.length) return `Finish ${v.name}'s contracts first.`;
    if (v.assist) return 'The tugs have her.';
    if (v.status === 'laidup' && v.docked !== h.id) return `${v.name} is laid up elsewhere.`;
    return null;
  }
  takeTradeIn(p, m) {
    if (m.tradeIn == null || m.tradeIn === false) return { cr: 0, v: null };
    const h = harborById(p.docked);
    if (!h) return { why: 'Moor in a harbour to trade in a ship.' };
    const v = this.ownVessel(p, m.tradeIn), why = this.tradeInWhy(p, v, h);
    if (why) return { why };
    return { cr: marketValue(v, h.country, this.now), v };
  }
  dropTradeIn(p, t, how = 'traded') {
    if (!t?.v) return;
    if (this.fleet?.removeVessel) this.fleet.removeVessel(p, t.v, how); else p.fleet = p.fleet.filter((x) => x !== t.v);
  }
  fleetRoom(p, extra = 0) { return (p.fleet?.length || 0) + this.openOf(p).length + extra < FLEET.MAX_VESSELS; }

  order(p, m) {
    const pv = parseVariant(m.variant);
    if (!pv) return this.warn(p, 'Unknown design.');
    const y = yardById(m.yard);
    if (!y) return this.warn(p, 'Unknown yard.');
    const can = canOrderAt(m.variant, m.yard);
    if (!can.ok) return this.warn(p, can.why);
    if (y.kind === 'local' && p.docked !== y.harbor) return this.warn(p, `Order from the ${y.name} while you are moored there.`);
    const chk = this.yardCheckFor(p);
    if (chk) { const r = chk(y.cc, y); if (r && r.ok === false) return this.warn(p, `Not allowed for your company: ${r.block?.text || POLI.reasonText?.(r.block) || y.cc}`); }
    if (p.office.owed > 0) return this.warn(p, `Settle the office's unpaid bills first (${fmt(p.office.owed)} cr).`);
    if (this.openOf(p).length >= YARD.MAX_OPEN_ORDERS) return this.warn(p, `You already have ${YARD.MAX_OPEN_ORDERS} ships on order.`);
    const t = this.takeTradeIn(p, m);
    if (t.why) return this.warn(p, t.why);
    if (!this.fleetRoom(p, t.v ? -1 : 0)) return this.warn(p, `Your fleet is full (${FLEET.MAX_VESSELS} ships and orders). Sell or trade in a ship first.`);
    const livery = m.livery == null ? defaultLivery(m.variant) : validLivery(m.livery);
    if (!livery) return this.warn(p, 'That paint scheme is not valid.');
    const name = m.name == null || m.name === '' ? null : validShipName(m.name);
    if (m.name && !name) return this.warn(p, 'Ship names are 2–24 letters, digits, spaces and . \' -');
    const id = this.newOrderId(p);
    const o = newOrder({ id, ownerId: p.id, variant: m.variant, yard: m.yard, createdAt: this.now, openOrders: this.openAt(m.yard), slot: m.slot, livery, name,
      registry: typeof m.registry === 'string' ? m.registry.slice(0, 40) : null, deliverTo: m.deliverTo, hull: this.hullNo(id), tradeIn: t.v ? { vesselId: t.v.id, cr: t.cr } : null });
    const first = o.schedule[0], dueNow = Math.max(0, first.cr - o.credit);
    if (Math.floor(p.money) < dueNow) return this.warn(p, `The contract instalment is ${fmt(dueNow)} cr. You have ${fmt(Math.floor(p.money))}.`);
    if (m.rush) {   // order and have her delivered at once: everything is paid now, plus the rush fee
      const q = this.rushQuote(p, o);
      if (Math.floor(p.money) < q.total) return this.warn(p, `A rush delivery costs ${fmt(q.total)} cr now (${fmt(q.cash)} cr of instalments + ${fmt(q.premium)} cr rush fee). You have ${fmt(Math.floor(p.money))}.`);
      if (!this.fleetRoom(p, t.v ? -1 : 0) || (p.fleet?.length || 0) >= FLEET.MAX_VESSELS) return this.warn(p, 'Your fleet is full: she could not be delivered at once.');
    }
    // financing (wave-2 bank): instalments are then paid by the loan first; without the bank, cash only
    if (m.loan && this.game.bank && typeof this.game.bank.offerShipLoan === 'function') {
      const f = financing(m.yard, o.price);
      const ln = this.game.bank.offerShipLoan(p, { orderId: o.id, price: o.price, ltv: f.ltv, years: f.years, agency: f.name, titleXI: f.titleXI });
      if (ln && ln.ok) { o.loanId = ln.loanId || null; o.loanCredit = Math.round(ln.cr || 0); }
    }
    this.ordersOf(p).push(o);
    this.dropTradeIn(p, t);
    this.payInstalment(p, o, first);
    this.say(p, 'info', `Ordered ${this.modelName(o.variant)} (${o.hull}) at ${this.yardName(o.yard)} for ${fmt(o.price)} cr — ${fmt(first.cr)} cr at signing${t.v ? ` (trade-in ${t.v.name} ${fmt(t.cr)} cr)` : ''}. Delivery in about ${Math.round((o.plannedDeliverAt - o.createdAt) / 3600)} h.`);
    if (m.rush) this.rush(p, { orderId: o.id });
    return o;
  }

  /** Pay one instalment: trade-in credit, then loan credit, then cash. Assumes the caller checked the cash. */
  payInstalment(p, o, inst) {
    let due = inst.cr;
    if (inst.key === 'delivery' && o.ldCr > 0) { inst.ld = Math.min(due, o.ldCr); due -= inst.ld; }
    const fromCredit = Math.min(due, o.credit || 0); o.credit = (o.credit || 0) - fromCredit; due -= fromCredit;
    const fromLoan = Math.min(due, o.loanCredit || 0); o.loanCredit = (o.loanCredit || 0) - fromLoan; due -= fromLoan;
    this.pay(p, due);
    inst.cash = due; inst.paidAt = this.now; o.warnedAt = 0;
    if (inst.key === 'delivery' && o.ldCr > inst.cr) this.refund(p, o.ldCr - inst.cr);
    return due;
  }
  cashDue(o, inst) {
    let due = inst.cr - (inst.key === 'delivery' ? Math.min(inst.cr, o.ldCr || 0) : 0);
    due -= Math.min(due, o.credit || 0);
    due -= Math.min(due, o.loanCredit || 0);
    return Math.max(0, due);
  }
  payAction(p, m) {
    const o = this.orderById(p, m.orderId);
    if (!o || !isOpen(o)) return this.warn(p, 'No such order.');
    const inst = o.schedule.find((s) => !s.paidAt && s.dueAt <= this.now);
    if (!inst) return this.warn(p, 'Nothing is due on this order yet.');
    const due = this.cashDue(o, inst);
    if (Math.floor(p.money) < due) return this.warn(p, `${KEY_TEXT[inst.key]} instalment: ${fmt(due)} cr due. You have ${fmt(Math.floor(p.money))}.`);
    this.payInstalment(p, o, inst);
    this.say(p, 'info', `${o.hull}: ${KEY_TEXT[inst.key].toLowerCase()} instalment paid (${fmt(due)} cr).`);
    this.process(p, o);
    return true;
  }
  /**
   * Rush delivery (speed-up): what it costs to have an open order delivered right now — the instalments still unpaid
   * (after trade-in and loan credit) plus a rush fee of price × (RUSH_BASE + RUSH_TIME × share of the build still to go).
   * null when the order can no longer be rushed. A rushed order forfeits its delay damages (it is not late).
   */
  rushQuote(p, o) {
    if (!o || !['ordered', 'building', 'launched'].includes(o.state)) return null;
    const end = o.delayShown ? o.deliverAt : o.plannedDeliverAt, total = Math.max(1, end - o.createdAt);
    const left = Math.max(0, Math.min(1, (end - this.now) / total));
    const premium = Math.round(o.price * (YARD.RUSH_BASE + YARD.RUSH_TIME * left));
    let credit = o.credit || 0, loan = o.loanCredit || 0, cash = 0;
    for (const inst of o.schedule) {
      if (inst.paidAt) continue;
      let due = inst.cr;
      const c = Math.min(due, credit); credit -= c; due -= c;
      const l = Math.min(due, loan); loan -= l; due -= l;
      cash += due;
    }
    return { premium, cash: Math.round(cash), total: Math.round(cash) + premium, left: Math.round(left * 1000) / 1000 };
  }
  rush(p, m) {
    const o = this.orderById(p, m.orderId);
    if (!o || !isOpen(o)) return this.warn(p, 'No such order.');
    const q = this.rushQuote(p, o);
    if (!q) return this.warn(p, 'This order cannot be rushed.');
    if (o.state === 'defaulted' || o.warnedAt) return this.warn(p, 'Settle the overdue instalment first.');
    if ((p.fleet?.length || 0) >= FLEET.MAX_VESSELS) return this.warn(p, `Your fleet is full (${FLEET.MAX_VESSELS} ships): she could not be delivered. Sell or trade in a ship first.`);
    if (Math.floor(p.money) < q.total) return this.warn(p, `A rush delivery costs ${fmt(q.total)} cr now (${fmt(q.cash)} cr of instalments + ${fmt(q.premium)} cr rush fee). You have ${fmt(Math.floor(p.money))}.`);
    o.ldCr = 0;   // not late: no damages (and none were deducted from the quote)
    for (const inst of o.schedule) if (!inst.paidAt) this.payInstalment(p, o, inst);
    this.pay(p, q.premium);
    const t = this.now;
    o.steelAt = Math.min(o.steelAt, t); o.keelAt = Math.min(o.keelAt ?? t, t); o.launchAt = Math.min(o.launchAt, t); o.deliverAt = t;
    o.state = 'ready'; o.readyAt = t; o.storagePaidTo = t;
    this.say(p, 'info', `${o.hull}: rush delivery — ${fmt(q.cash)} cr of instalments and ${fmt(q.premium)} cr rush fee paid. The yard works round the clock.`);
    return this.deliver(p, o) ? q.total : false;
  }
  cancel(p, m) {
    const o = this.orderById(p, m.orderId);
    if (!o || !['ordered', 'building', 'launched'].includes(o.state)) return this.warn(p, 'This order can no longer be cancelled.');
    const paid = o.schedule.filter((s) => s.paidAt);
    const refund = Math.round(paid.slice(1).reduce((s, x) => s + x.cr, 0) * YARD.CANCEL_REFUND);
    o.state = 'cancelled'; o.endedAt = this.now;
    this.refund(p, refund);
    this.say(p, 'info', `Cancelled ${o.hull} at ${this.yardName(o.yard)}. The deposit is lost${refund ? `; ${fmt(refund)} cr of later instalments refunded` : ''}.`);
    this.prune(p);
    return refund;
  }

  // ------------------------------------------------------------------------------------------------ world clock (H4)
  tick(simTime = this.game.simTime) {
    const t = Math.floor(simTime);
    if (t === this.lastTick) return;
    this.lastTick = t;
    for (const p of this.players()) {
      const os = p.office?.orders;
      if (!Array.isArray(os) || !os.length) continue;
      for (const o of os) if (isOpen(o)) this.process(p, o);
    }
  }
  /** Advance one order: due instalments, milestones, default, readiness, delivery or storage. */
  process(p, o) {
    const now = this.now;
    let overdue = false;
    for (const inst of o.schedule) {
      if (inst.paidAt || inst.dueAt > now) continue;
      if (o.state === 'ready') break;
      const due = this.cashDue(o, inst);
      if (Math.floor(p.money) >= due) {
        this.payInstalment(p, o, inst);
        if (inst.key !== 'contract') this.say(p, 'info', `${KEY_TEXT[inst.key]} for ${o.hull} (${this.modelName(o.variant)}) at ${this.yardName(o.yard)} — ${fmt(due)} cr paid.`);
        continue;
      }
      if (now >= inst.dueAt + YARD.GRACE_H * 3600) { this.defaulted(p, o, inst); return; }
      if (!o.warnedAt) {
        o.warnedAt = now;
        this.say(p, 'warn', `${o.hull}: the ${KEY_TEXT[inst.key].toLowerCase()} instalment of ${fmt(due)} cr is due and your cash is short. Pay within ${YARD.GRACE_H} h or the yard cancels the contract.`);
      }
      overdue = true;
      break;
    }
    if (o.state === 'defaulted' || overdue) return;   // Game rule: the yard holds the hull at her stage while an instalment is overdue
    if (o.state === 'ordered' && now >= o.steelAt) o.state = 'building';
    if (o.state === 'building' && now >= o.launchAt) {
      o.state = 'launched';
      if (o.delayFrac > 0 && !o.delayShown) {
        o.delayShown = true;
        this.say(p, 'warn', `Sea trials found a problem on ${o.hull}: delivery moves to ${new Date(o.deliverAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC. The yard will credit ${fmt(o.ldCr)} cr of liquidated damages at delivery.`);
      }
    }
    if (o.state === 'launched' && now >= o.deliverAt && o.schedule.every((s) => s.paidAt)) { o.state = 'ready'; o.readyAt = now; o.storagePaidTo = now; }
    if (o.state === 'ready') {
      if (!this.deliver(p, o)) this.chargeStorage(p, o);
    }
  }
  defaulted(p, o, inst) {
    o.state = 'defaulted'; o.endedAt = this.now;
    this.say(p, 'warn', `${o.hull}: the ${KEY_TEXT[inst.key].toLowerCase()} instalment was not paid within ${YARD.GRACE_H} h. ${this.yardName(o.yard)} has cancelled the contract and keeps what was paid.`);
    this.prune(p);
  }
  chargeStorage(p, o) {
    const days = Math.floor((this.now - (o.storagePaidTo || o.readyAt)) / 86400);
    if (days < 1) return;
    const fee = days * yardStorageFeePerDay(o.variant);
    o.storagePaidTo = (o.storagePaidTo || o.readyAt) + days * 86400;
    o.storageCr = (o.storageCr || 0) + fee;
    if (this.fleet?.charge) this.fleet.charge(p, '_', 'storage', fee); else p.money -= fee;
  }
  prune(p) {
    const os = this.ordersOf(p), done = os.filter((o) => !isOpen(o));
    if (done.length > YARD.ORDERS_KEEP) { const drop = new Set(done.sort((a, b) => a.endedAt - b.endedAt).slice(0, done.length - YARD.ORDERS_KEEP)); p.office.orders = os.filter((o) => !drop.has(o)); }
  }

  // ------------------------------------------------------------------------------------------------ delivery
  /** A new vessel docked at harbour h (berth or anchorage), with spec, hist and the politics fields. */
  createVessel(p, h, { variant, name, livery, cond = 100, price, yardId, builtIn, hist }) {
    const f = this.fleet, g = this.game, sim = g.simTime, row = classRow(variant);
    const names = (p.fleet || []).map((v) => v.name);
    let nm = validShipName(name);
    if (!nm || names.some((n) => n.toLowerCase() === nm.toLowerCase())) nm = defaultShipName(names);
    const spot = f.freeBerth(h, variant);
    const id = f.newId();
    const v = f.makeVessel(p.id, {
      id, name: nm, ship: { cls: variant, lat: spot.lat, lon: spot.lon, hdg: spot.hdg ?? 0, spd: 0, throttle: 0, rudder: 0 },
      cond, fuel: r1(FLEET.NEW_FUEL_FRAC * (row?.fuelCap || 0)), kits: 0, docked: h.id, dockedAt: sim, berth: spot.berth ? berthRef(h, spot.berth, spot.hdg) : null,
      shipTime: sim, acquiredAt: Math.floor(sim), acquiredPrice: price,
    });
    const pv = parseVariant(variant);
    v.spec = { v: 1, model: pv.model, opts: pv.opts, livery: livery || defaultLivery(variant) };
    v.hist = hist;
    v.built = hist.built; v.builtIn = builtIn; v.scrubber = pv.tokens.includes('scr');
    if (g.politics && typeof g.politics.newVesselFlag === 'function') {
      try { g.politics.newVesselFlag(p, v, { builtIn }); v.built = hist.built; } catch { /* politics optional */ }
    }
    v.cap = captain.newCap(g, 'idle');
    p.fleet.push(v); f.index(v);
    void yardId;
    return v;
  }
  /** `ready` → delivered when the fleet has room. → the vessel or null. */
  deliver(p, o) {
    if ((p.fleet?.length || 0) >= FLEET.MAX_VESSELS) {
      if (!o.fullWarned) { o.fullWarned = true; this.say(p, 'warn', `${o.hull} is finished but your fleet is full: she waits at ${this.yardName(o.yard)} (storage ${fmt(yardStorageFeePerDay(o.variant))} cr/day).`); }
      return null;
    }
    const y = yardById(o.yard), h = harborById(y.harbor);
    const year = new Date(this.now * 1000).getUTCFullYear();
    const m = MODELS[o.model];
    const hist = { v: 1, built: year, builtAt: this.now, yard: o.yard, builtIn: y.cc, hull: o.hull, class: CLASS_BY_CC[y.cc] === 'RS' ? 'RS' : CLASS_BY_CC[y.cc] || 'LR',
      owners: 1, lastDock: this.now, nextSpecial: year + 5, incidents: [], runHours: 0, estimated: false, jonesLost: false, rebuiltAbroad: false,
      warrantyTo: this.now + YARD.WARRANTY_H * 3600, specialist: isSpecialist(y, m), orderId: o.id };
    const v = this.createVessel(p, h, { variant: o.variant, name: o.name, livery: o.livery, price: o.price, yardId: o.yard, builtIn: y.cc, hist });
    o.state = 'delivered'; o.vesselId = v.id; o.endedAt = this.now;
    const ld = o.ldCr > 0 ? ` Liquidated damages credited: ${fmt(o.ldCr)} cr.` : '';
    this.say(p, 'info', `Delivered: ${v.name} (${this.modelName(o.variant)}, ${o.hull}) at ${short(h.name)}. Under warranty for ${Math.round(YARD.WARRANTY_H / 24)} days.${ld}`);
    if (o.deliverTo === 'home' && p.office.home && p.office.home !== h.id) this.sendHome(p, v, !!o.express);
    this.prune(p);
    return v;
  }
  deliveryQuote(p, o) {
    const y = yardById(o.yard), h = harborById(y?.harbor), home = harborById(p.office?.home);
    if (!h || !home || h.id === home.id) return null;
    const nm = (haversine(h.lat, h.lon, home.lat, home.lon) / 1852) * RATES.DETOUR;
    const kn = (classRow(o.variant)?.maxKn || 12) * RATES.SERVICE_THROTTLE;
    return { to: home.id, nm: Math.round(nm), hours: Math.round((nm / kn) * 10) / 10, express: Math.round(SIM.EXPRESS_CR_PER_NM * nm) };
  }
  /** Delivery crew (captain order home) or express delivery (paid like an express passage, she appears at home). */
  sendHome(p, v, express) {
    const home = harborById(p.office.home), from = harborById(v.docked);
    if (!home || !from) return false;
    if (express) {
      const nm = (haversine(from.lat, from.lon, home.lat, home.lon) / 1852) * RATES.DETOUR, cost = Math.round(SIM.EXPRESS_CR_PER_NM * nm);
      if (Math.floor(p.money) < cost) { this.warn(p, `Express delivery costs ${fmt(cost)} cr. A delivery crew sails her home instead.`); }
      else {
        this.pay(p, cost, 'fees', v.id);
        const spot = this.fleet.freeBerth(home, v.ship.cls, v.id);
        Object.assign(v.ship, { lat: spot.lat, lon: spot.lon, hdg: spot.hdg ?? 0, spd: 0 });
        v.docked = home.id; v.dockedAt = this.game.simTime; v.berth = spot.berth ? berthRef(home, spot.berth, spot.hdg) : null;
        this.fleet.gridAt = -1;
        this.say(p, 'info', `${v.name} delivered to ${short(home.name)} by express (${fmt(cost)} cr).`);
        return true;
      }
    }
    captain.setOrder(this.fleet, v, { type: 'home', then: 'moor' });
    this.say(p, 'info', `A delivery crew is sailing ${v.name} to ${short(home.name)}.`);
    return true;
  }
  deliverAction(p, m) {
    const o = this.orderById(p, m.orderId);
    if (!o) return this.warn(p, 'No such order.');
    if (isOpen(o)) { o.deliverTo = m.to === 'home' ? 'home' : 'yard'; o.express = !!m.express; this.say(p, 'info', `${o.hull} will be ${o.deliverTo === 'home' ? `delivered to your home harbour${o.express ? ' by express' : ' by a delivery crew'}` : 'handed over at the yard'}.`); return true; }
    const v = o.state === 'delivered' ? this.ownVessel(p, o.vesselId) : null;
    if (!v || !v.docked || p.aboard === v.id) return this.warn(p, 'She is no longer waiting at the yard.');
    return this.sendHome(p, v, !!m.express);
  }

  // ------------------------------------------------------------------------------------------------ stock hulls
  stockIdx() { return Math.floor(this.now / (YARD.STOCK_REFRESH_H * 3600)); }
  /** Finished hulls at this harbour's yards (and its local boatyard), delivered at once for +8 %. */
  stockAt(h) {
    const idx = this.stockIdx(), st = this.game.harbors?.[h.id];
    const sold = st && st.yardSold && st.yardSold.idx === idx ? st.yardSold.ids : [];
    const ys = YARD_IDS.filter((id) => YARDS[id].harbor === h.id).map((id) => YARDS[id]);
    const ly = localYard(h); if (ly) ys.push(ly);
    const out = [];
    for (const y of ys) for (const model of y.stockOf || []) {
      if (seededRnd(`stock:${y.id}:${model}:${idx}`)() >= YARD.STOCK_P) continue;
      const id = `s${idx.toString(36)}-${y.id.replace(':', '-')}-${model}`;
      if (sold.includes(id) || !canOrderAt(model, y.id).ok) continue;
      out.push({ id, yard: y.id, variant: model, price: stockPrice(model, y.id), livery: defaultLivery(model), name: MODELS[model].refName });
    }
    return out;
  }
  buyStock(p, m) {
    const h = harborById(p.docked);
    if (!h) return this.warn(p, 'Moor at the yard to buy a finished hull.');
    const s = this.stockAt(h).find((x) => x.id === m.stockId);
    if (!s) return this.warn(p, 'That hull has been sold.');
    const y = yardById(s.yard);
    const chk = this.yardCheckFor(p);
    if (chk) { const r = chk(y.cc, y); if (r && r.ok === false) return this.warn(p, `Not allowed for your company: ${r.block?.text || y.cc}`); }
    const t = this.takeTradeIn(p, m); if (t.why) return this.warn(p, t.why);
    if (!this.fleetRoom(p, t.v ? -1 : 0)) return this.warn(p, `Your fleet is full (${FLEET.MAX_VESSELS} ships and orders).`);
    const cost = s.price - t.cr;
    if (Math.floor(p.money) < cost) return this.warn(p, `This hull costs ${fmt(s.price)} cr${t.cr ? ` (${fmt(cost)} after trade-in)` : ''}. You have ${fmt(Math.floor(p.money))}.`);
    const st = (this.game.harbors[h.id] ||= {}), idx = this.stockIdx();
    if (!st.yardSold || st.yardSold.idx !== idx) st.yardSold = { idx, ids: [] };
    st.yardSold.ids.push(s.id);
    this.dropTradeIn(p, t);
    this.pay(p, Math.max(0, cost));
    if (cost < 0) this.refund(p, -cost);
    const year = new Date(this.now * 1000).getUTCFullYear(), hullNo = this.hullNo(s.id);
    const hist = { v: 1, built: year, builtAt: this.now, yard: y.id, builtIn: y.cc, hull: hullNo, class: CLASS_BY_CC[y.cc] || 'LR', owners: 1, lastDock: this.now, nextSpecial: year + 5,
      incidents: [], runHours: 0, estimated: false, jonesLost: false, rebuiltAbroad: false, warrantyTo: this.now + YARD.WARRANTY_H * 3600, specialist: isSpecialist(y, MODELS[s.variant]) };
    const v = this.createVessel(p, h, { variant: s.variant, name: m.name, livery: validLivery(m.livery) || s.livery, price: s.price, yardId: y.id, builtIn: y.cc, hist });
    this.say(p, 'info', `Bought a finished ${this.modelName(s.variant)} from ${this.yardName(y.id)}: ${v.name}, ${fmt(s.price)} cr.`);
    return v;
  }

  // ------------------------------------------------------------------------------------------------ second-hand market
  /** The listings of a harbour, regenerated every ECON.USED_REFRESH_H on the world clock (seeded per harbour and window). */
  listingsAt(h) {
    const st = (this.game.harbors[h.id] ||= {});
    const idx = Math.floor(this.now / (ECON.USED_REFRESH_H * 3600));
    if (st.yardUsedIdx !== idx || !Array.isArray(st.yardUsed)) {
      const n = SIZE_LISTINGS[h.size] || 2, out = [];
      for (let slot = 0; slot < n; slot++) { const l = makeListing(h, slot, idx, null, { simTime: this.now }); if (l) out.push(l); }
      st.yardUsed = out; st.yardUsedIdx = idx;
    }
    return st.yardUsed;
  }
  listingById(h, id) { return typeof id === 'string' ? this.listingsAt(h).find((l) => l.id === id) || null : null; }
  reportFor(l, p) {
    const r = l.inspections?.[p.id];
    if (!r || this.now < r.readyAt) return null;
    if (!r.report) r.report = inspectionReport(l, r.readyAt);
    return r.report;
  }
  inspect(p, m) {
    const h = harborById(p.docked);
    if (!h) return this.warn(p, 'Moor in the harbour where she lies to have her inspected.');
    const l = this.listingById(h, m.listingId);
    if (!l) return this.warn(p, 'That ship has been sold.');
    if (l.inspections?.[p.id]) return this.warn(p, 'Your surveyor is already on it.');
    const fee = inspectFee(l.price);
    if (Math.floor(p.money) < fee) return this.warn(p, `A pre-purchase inspection costs ${fmt(fee)} cr.`);
    this.pay(p, fee, 'fees');
    (l.inspections ||= {})[p.id] = { at: this.now, readyAt: this.now + YARD.INSPECT_H * 3600, fee, report: null };
    this.say(p, 'info', `A surveyor is inspecting the ${l.name} (${fmt(fee)} cr). Report in ${YARD.INSPECT_H} h.`);
    return fee;
  }
  buyUsed(p, m) {
    const h = harborById(p.docked);
    if (!h) return this.warn(p, 'Moor in a harbour to buy a ship.');
    const l = this.listingById(h, m.listingId);
    if (!l) return this.warn(p, 'That ship has been sold.');
    if (p.office.owed > 0) return this.warn(p, `Settle the office's unpaid bills first (${fmt(p.office.owed)} cr).`);
    const t = this.takeTradeIn(p, m); if (t.why) return this.warn(p, t.why);
    if (!this.fleetRoom(p, t.v ? -1 : 0)) return this.warn(p, `Your fleet is full (${FLEET.MAX_VESSELS} ships and orders).`);
    const cost = l.price - t.cr;
    if (Math.floor(p.money) < cost) return this.warn(p, `She costs ${fmt(l.price)} cr${t.cr ? ` (${fmt(cost)} after trade-in)` : ''}. You have ${fmt(Math.floor(p.money))}.`);
    this.dropTradeIn(p, t);
    this.pay(p, Math.max(0, cost));
    if (cost < 0) this.refund(p, -cost);
    const hist = { ...l.hist, owners: l.hist.owners + 1, flags: l.hist.flags.map((x) => ({ ...x })), incidents: l.hist.incidents.map((x) => ({ ...x })), defects: l.defect ? [{ ...l.defect }] : [] };
    const v = this.createVessel(p, h, { variant: l.cls, name: m.name, livery: defaultLivery(l.cls), cond: l.cond, price: l.price, yardId: l.hist.yard, builtIn: l.hist.builtIn, hist });
    v.built = l.hist.built;
    if (v.serviceDue) v.serviceDue = this.game.simTime + 30 * 86400 * (0.2 + 0.6 * (l.cond / 100));
    const st = this.game.harbors[h.id]; st.yardUsed = st.yardUsed.filter((x) => x !== l);
    this.say(p, 'info', `Bought the ${l.age}-year-old ${l.name}, built ${l.hist.built} in ${l.hist.builtIn}: ${v.name}, ${fmt(l.price)} cr.`);
    return v;
  }

  // ------------------------------------------------------------------------------------------------ repaint / rename
  repaint(p, m) {
    const v = this.ownVessel(p, m.vesselId);
    if (!v) return this.warn(p, 'That is not your ship.');
    const h = harborById(v.docked);
    if (!h || !(YARD_IDS.some((id) => YARDS[id].harbor === h.id) || localYard(h))) return this.warn(p, `${v.name} must lie at a harbour with a yard or boatyard.`);
    const livery = validLivery(m.livery);
    if (!livery) return this.warn(p, 'That paint scheme is not valid.');
    const cost = repaintCost(v.ship.cls);
    if (Math.floor(p.money) < cost) return this.warn(p, `Repainting costs ${fmt(cost)} cr.`);
    this.pay(p, cost, 'fees', v.id);
    if (!v.spec) healShipsVessel(v, this.now);
    v.spec.livery = livery; v.repaintUntil = this.now + YARD.REPAINT_H * 3600;
    this.say(p, 'info', `${v.name} is being repainted (${fmt(cost)} cr, ${YARD.REPAINT_H} h alongside).`);
    return cost;
  }
  rename(p, m) {
    const v = this.ownVessel(p, m.vesselId);
    if (!v) return this.warn(p, 'That is not your ship.');
    const name = validShipName(m.name);
    if (!name) return this.warn(p, 'Ship names are 2–24 letters, digits, spaces and . \' -');
    if (p.fleet.some((x) => x !== v && x.name.toLowerCase() === name.toLowerCase())) return this.warn(p, 'You already have a ship of that name.');
    const old = v.name; v.name = name;
    this.say(p, 'info', `${old} is renamed ${name}.`);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ politics hooks
  /** Politics re-flag callback (pol_reflag → reflagComplete): coastwise rights are lost for ever when the flag leaves the US. */
  onReflag(p, v, fromCc, toCc) {
    if (noteFlagChange(v, fromCc, toCc) && jonesOk({ ...v, hist: { ...v.hist, jonesLost: false } })) this.say(p, 'warn', `${v.name} has left the US flag: she can never again trade between US ports (46 U.S.C. §12132).`);
  }
  /** Migration (H8): spec/hist on every vessel, office.orders on every office. */
  heal(p) { healOrders(p.office); for (const v of p.fleet || []) healShipsVessel(v, this.now); }
}
