// The casino of a cruise ship, server side (docs/CRUISE-CONTRACT.md §7). The ONLY place a game is rolled and paid: the client sends
// what the player wants (a bet, a decision), this file validates it against the player's credits and the table limits of the
// ship, rolls with the server's RNG (node:crypto), pays and books. Nothing the client says about cards, numbers or balances is
// believed. Credits only: the game has no real money.
//
//   C→S  { action: 'casino', game: 'roulette'|'blackjack'|'baccarat'|'slots'|'poker', op, ... }      (see handle())
//   S→C  { t: 'casino', game, op, ok, view, net, money, limits, cool?, text? }                           (view hides unseen cards)
//
// Rules of the house (shared/casino.js PLAY_RULES): at least 0.5 s between bets and at most 90 a minute, a session that loses more
// than 6 × the table maximum in an hour is cooled off for 10 minutes, bets are whole credits between the table limits of the
// ship's class, never more than the player has: the balance can not go negative. Whatever the player wins or loses is booked to the
// company's books (fleet ledger day book: income / costs) and to p.stats.casino = { wagered, returned, rounds }, the casino's own account
// (house = wagered − returned). A round in progress (blackjack, poker) is kept in memory; if the player walks away it is settled
// after 10 minutes (stand / fold), so credits are never lost silently and never kept by a stale client.
import crypto from 'node:crypto';
import * as C from '../shared/casino.js';
import { visit } from './venues.js';

const GAMES = ['roulette', 'blackjack', 'baccarat', 'slots', 'poker'];
const IDLE_S = 600;
/** Server RNG: uniform in [0, 1) with 53 bits. */
export const secureRnd = () => { const b = crypto.randomBytes(7); return ((b.readUIntBE(0, 3) * 2 ** 32 + b.readUIntBE(3, 4)) % 2 ** 53) / 2 ** 53; };

/** What a client may see of a blackjack round (the dealer's hole card stays hidden until the dealer plays). */
export function viewBj(s) {
  const done = s.phase === 'done';
  return { phase: s.phase, hands: s.hands.map((h) => ({ cards: h.cards, bet: h.bet, doubled: h.doubled, split: h.split, value: C.handValue(h.cards).total })), active: s.active, dealer: done ? s.dealer : [s.dealer[0]], dealerValue: done ? C.handValue(s.dealer).total : null,
    options: C.bjOptions(s), results: s.results || null, returned: done ? s.returned : null, paid: s.paid };
}
/** What a client may see of a poker hand: its own hole cards, the board dealt so far, the guests' cards only at a showdown. */
export function viewPoker(s) {
  const done = s.phase === 'done', board = done ? (s.showdown || !s.folded[0] ? s.board : C.pokerBoard(s)) : C.pokerBoard(s);
  return { phase: s.phase, stage: ['preflop', 'flop', 'turn', 'river'][Math.min(3, s.stage)], pot: s.pot, board, you: s.hole[0], folded: s.folded, in: s.inn, options: C.pokerOptions(s), costs: Object.fromEntries(C.pokerOptions(s).map((o) => [o, C.pokerCost(s, o)])),
    log: s.log || [], seats: done && s.showdown ? s.hole.map((h, i) => (s.folded[i] ? null : { cards: h, name: C.handName(h.score) })) : null, winners: done ? s.winners : null, rake: done ? s.rake : null, returned: done ? s.returned : null, paid: s.inn[0], unit: s.u };
}

export class Casino {
  /** game: { send(p, msg), event(p, kind, text), sendYou(p), fleet?: { book(p, vid, cat, amt) }, simTime? }. opts: { rnd, now } for tests. */
  constructor(game, opts = {}) { this.game = game; this.rnd = opts.rnd || secureRnd; this.now = opts.now || (() => Date.now() / 1000); this.sess = new Map(); }
  S(p) {
    let s = this.sess.get(p.id);
    if (!s) { s = { last: 0, stamps: [], hist: [], cool: 0, bj: null, poker: null, at: 0 }; this.sess.set(p.id, s); }
    return s;
  }
  forget(p) { this.sess.delete(p.id); }
  limitsOf(p) { return C.tableLimits(p.ship?.cls); }
  /** The company's books: the casino result of a round (net to the player; the house has the opposite) as income or costs, no money moves here. */
  ledger(p, net) {
    if (!net || !p.office?.book?.days || !this.game.fleet?.addDay) return;
    try { this.game.fleet.addDay(p, p.vesselId || '_', net > 0 ? 'income' : 'costs', net); } catch { /* the books are best effort: the purse is what counts */ }
  }
  /** One-shot game: stake and return together. The balance never goes below 0 (the stake was checked against it first). */
  pay(p, stake, returned) {
    const ret = Math.floor(returned + 1e-9), net = ret - stake;
    if (!Number.isSafeInteger(net) || stake > p.money) throw new Error('bad amount');
    p.money += net; this.ledger(p, net); this.stat(p, stake, ret);
    const s = this.S(p); s.hist.push([this.now(), net]); const cut = this.now() - C.PLAY_RULES.WINDOW_S; s.hist = s.hist.filter((h) => h[0] >= cut);
    return net;
  }
  /** Debit a stake now (a bet placed in a multi-step game). */
  take(p, amt) { if (!Number.isSafeInteger(amt) || amt <= 0 || p.money < amt) return false; p.money -= amt; return true; }
  give(p, amt) { if (amt > 0) p.money += amt; }
  reply(p, game, op, extra = {}) {
    const lim = this.limitsOf(p), s = this.S(p);
    this.game.send(p, { t: 'casino', game, op, money: p.money, limits: lim, cool: Math.max(0, Math.ceil(s.cool - this.now())), ...extra });
    this.game.sendYou?.(p);
  }
  refuse(p, game, op, text) { this.reply(p, game, op, { ok: false, text }); return false; }

  /** Rate and responsible-play gate. Returns an error text or null. */
  gate(p, s) {
    const t = this.now(), R = C.PLAY_RULES;
    if (s.cool > t) return `Cooling-off: the casino is closed to you for ${Math.ceil((s.cool - t) / 60)} more minute(s). Take a break.`;
    if (t - s.last < R.MIN_GAP_S) return 'Slow down — one bet at a time.';
    s.stamps = s.stamps.filter((x) => x > t - 60);
    if (s.stamps.length >= R.MAX_PER_MIN) return 'Too many bets this minute. Take a moment.';
    return null;
  }
  mark(p, s) {
    const t = this.now(); s.last = t; s.stamps.push(t); visit(this.game, p, 'casino');
    const lim = this.limitsOf(p), loss = -s.hist.reduce((a, h) => a + h[1], 0);
    if (lim && loss > C.PLAY_RULES.LOSS_CAP_X * lim.max) { s.cool = t + C.PLAY_RULES.COOLOFF_S; s.hist = []; this.game.event?.(p, 'info', 'You have lost a lot at the tables tonight. The casino asks you to take a 10-minute break.'); }
  }
  /** Settle rounds left open for IDLE_S: blackjack stands, poker folds. */
  sweep(p, s) {
    const t = this.now();
    if (s.bj && t - s.at > IDLE_S) { let b = s.bj; while (b.phase === 'play') b = C.bjAct(b, 'stand', this.rnd); this.give(p, Math.floor(b.returned + 1e-9)); this.stat(p, b.paid, b.returned); this.ledger(p, Math.floor(b.returned + 1e-9) - b.paid); s.bj = null; }
    if (s.poker && t - s.at > IDLE_S) { const q = this.fold(s.poker); this.stat(p, q.inn[0], q.returned); this.give(p, Math.floor(q.returned + 1e-9)); this.ledger(p, Math.floor(q.returned + 1e-9) - q.inn[0]); s.poker = null; }
  }
  stat(p, stake, returned) { const st = (p.stats.casino ||= { wagered: 0, returned: 0, rounds: 0 }); st.wagered += stake; st.returned += Math.floor(returned + 1e-9); st.rounds++; }
  fold(q) { return q.phase === 'done' ? q : C.pokerAct(q, C.pokerOptions(q).includes('fold') ? 'fold' : 'call', this.rnd); }

  /** The `casino` action. */
  onAction(p, m) {
    const game = String(m.game || ''), op = String(m.op || '');
    if (!p.stats) p.stats = {};
    const lim = this.limitsOf(p);
    if (!lim) return this.refuse(p, game, op, 'This ship has no casino.');
    if (op === 'limits' || op === 'sync') { const s = this.S(p); this.sweep(p, s); return this.reply(p, game, op, { ok: true, view: this.currentView(s, game) }); }
    if (!GAMES.includes(game)) return this.refuse(p, game, op, 'Unknown game.');
    const s = this.S(p); this.sweep(p, s);
    try { return this[game](p, s, m, lim, op); } catch (e) { return this.refuse(p, game, op, `Not allowed: ${e.message}`); }
  }
  currentView(s, game) { return game === 'blackjack' && s.bj ? viewBj(s.bj) : game === 'poker' && s.poker ? viewPoker(s.poker) : null; }
  intAmt(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null; }   // numbers only: a string is not a bet
  inLimits(a, lim) { return a !== null && a >= lim.min && a <= lim.max; }

  roulette(p, s, m, lim, op) {
    if (op !== 'spin') return this.refuse(p, 'roulette', op, 'Unknown operation.');
    const bets = Array.isArray(m.bets) ? m.bets.slice(0, 40).map((b) => ({ type: String(b?.type), n: b?.n, amt: b?.amt })) : [];
    if (!bets.length) return this.refuse(p, 'roulette', op, 'Place a bet first.');
    for (const b of bets) { if (!C.validBet(b)) return this.refuse(p, 'roulette', op, 'That bet is not on the layout.'); if (!this.inLimits(b.amt, lim)) return this.refuse(p, 'roulette', op, `Bets are ${lim.min}–${lim.max} cr at this table.`); }
    const stake = bets.reduce((a, b) => a + b.amt, 0);
    if (stake > p.money) return this.refuse(p, 'roulette', op, 'You do not have the credits for those bets.');
    const g = this.gate(p, s); if (g) return this.refuse(p, 'roulette', op, g);
    const n = C.spinRoulette(this.rnd), r = C.settleRoulette(bets, n);
    const net = this.pay(p, stake, r.returned); this.mark(p, s);
    return this.reply(p, 'roulette', op, { ok: true, net, view: { number: n, colour: r.colour, stake, returned: Math.floor(r.returned + 1e-9), wins: r.wins } });
  }
  baccarat(p, s, m, lim, op) {
    if (op !== 'deal') return this.refuse(p, 'baccarat', op, 'Unknown operation.');
    const b = { player: m.bets?.player || 0, banker: m.bets?.banker || 0, tie: m.bets?.tie || 0 };
    for (const k of Object.keys(b)) if (b[k] && (typeof b[k] !== 'number' || !Number.isSafeInteger(b[k]) || !this.inLimits(b[k], lim))) return this.refuse(p, 'baccarat', op, `Bets are ${lim.min}–${lim.max} cr at this table.`);
    const stake = b.player + b.banker + b.tie;
    if (stake <= 0) return this.refuse(p, 'baccarat', op, 'Place a bet first.');
    if (stake > p.money) return this.refuse(p, 'baccarat', op, 'You do not have the credits for those bets.');
    const g = this.gate(p, s); if (g) return this.refuse(p, 'baccarat', op, g);
    const rd = C.baccaratRound(this.rnd), r = C.settleBaccarat(b, rd), net = this.pay(p, stake, r.returned); this.mark(p, s);
    return this.reply(p, 'baccarat', op, { ok: true, net, view: { player: rd.player, banker: rd.banker, pv: rd.pv, bv: rd.bv, outcome: rd.outcome, stake, returned: Math.floor(r.returned + 1e-9) } });
  }
  slots(p, s, m, lim, op) {
    if (op !== 'spin') return this.refuse(p, 'slots', op, 'Unknown operation.');
    const lb = this.intAmt(m.lineBet), stake = lb ? lb * C.LINES.length : 0;
    if (!lb || !this.inLimits(stake, lim)) return this.refuse(p, 'slots', op, `Total bet is ${lim.min}–${lim.max} cr (ten lines).`);
    if (stake > p.money) return this.refuse(p, 'slots', op, 'You do not have the credits for that bet.');
    const g = this.gate(p, s); if (g) return this.refuse(p, 'slots', op, g);
    const r = C.spinSlots(lb, this.rnd), net = this.pay(p, stake, r.returned); this.mark(p, s);
    return this.reply(p, 'slots', op, { ok: true, net, view: { stops: r.stops, window: r.window, hits: r.hits, scatters: r.scatters, pays: r.pays, free: r.free, freeSpins: r.freeSpins, stake, returned: Math.floor(r.returned + 1e-9) } });
  }
  blackjack(p, s, m, lim, op) {
    if (op === 'deal') {
      if (s.bj) return this.refuse(p, 'blackjack', op, 'Finish the hand in front of you first.');
      const bet = this.intAmt(m.bet);
      if (!this.inLimits(bet, lim)) return this.refuse(p, 'blackjack', op, `Bets are ${lim.min}–${lim.max} cr at this table.`);
      if (bet > p.money) return this.refuse(p, 'blackjack', op, 'You do not have the credits for that bet.');
      const g = this.gate(p, s); if (g) return this.refuse(p, 'blackjack', op, g);
      this.take(p, bet);
      const b = C.bjStart(bet, this.rnd); s.at = this.now(); this.mark(p, s);
      return this.bjAfter(p, s, b, op);
    }
    const b = s.bj; if (!b) return this.refuse(p, 'blackjack', op, 'No hand in play — deal first.');
    if (!['hit', 'stand', 'double', 'split'].includes(op)) return this.refuse(p, 'blackjack', op, 'Unknown operation.');
    if (!C.bjOptions(b).includes(op)) return this.refuse(p, 'blackjack', op, `You cannot ${op} now.`);
    const extra = C.bjExtra(b, op);
    if (extra > 0 && (extra > p.money || !this.take(p, extra))) return this.refuse(p, 'blackjack', op, 'You do not have the credits to do that.');
    s.at = this.now();
    return this.bjAfter(p, s, C.bjAct(b, op, this.rnd), op);
  }
  bjAfter(p, s, b, op) {
    if (b.phase !== 'done') { s.bj = b; return this.reply(p, 'blackjack', op, { ok: true, view: viewBj(b) }); }
    s.bj = null;
    const ret = Math.floor(b.returned + 1e-9); this.give(p, ret); this.stat(p, b.paid, b.returned);
    s.hist.push([this.now(), ret - b.paid]); this.ledger(p, ret - b.paid);
    return this.reply(p, 'blackjack', op, { ok: true, net: ret - b.paid, view: viewBj(b) });
  }
  poker(p, s, m, lim, op) {
    if (op === 'deal') {
      if (s.poker) return this.refuse(p, 'poker', op, 'Finish the hand first.');
      const u = lim.min;
      if (u * 2 > p.money) return this.refuse(p, 'poker', op, 'You do not have the credits to sit down (the ante and a bet).');
      const g = this.gate(p, s); if (g) return this.refuse(p, 'poker', op, g);
      this.take(p, u);
      s.poker = C.pokerStart(u, this.rnd); s.at = this.now(); this.mark(p, s);
      return this.reply(p, 'poker', op, { ok: true, view: viewPoker(s.poker) });
    }
    const q = s.poker; if (!q) return this.refuse(p, 'poker', op, 'No hand in play — deal first.');
    if (!C.pokerOptions(q).includes(op)) return this.refuse(p, 'poker', op, `You cannot ${op} now.`);
    const cost = C.pokerCost(q, op);
    if (cost > 0 && (cost > p.money || !this.take(p, cost))) return this.refuse(p, 'poker', op, 'You do not have the credits to do that. Fold or call what you can.');
    s.at = this.now();
    const n = C.pokerAct(q, op, this.rnd);
    if (n.phase !== 'done') { s.poker = n; return this.reply(p, 'poker', op, { ok: true, view: viewPoker(n) }); }
    s.poker = null;
    const ret = Math.floor(n.returned + 1e-9); this.give(p, ret); this.stat(p, n.inn[0], n.returned);
    s.hist.push([this.now(), ret - n.inn[0]]); this.ledger(p, ret - n.inn[0]);
    return this.reply(p, 'poker', op, { ok: true, net: ret - n.inn[0], view: viewPoker(n) });
  }
}
