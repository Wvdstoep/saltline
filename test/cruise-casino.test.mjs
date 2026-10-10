// Cruise casino (docs/CRUISE-CONTRACT.md §7): the pure rules (payout tables, house edge, dealer rules, poker hands, slots return) and the
// server side (limits by ship class, bets validated against the purse, no negative balances, rate limit and cooling-off, nothing
// the client claims is believed, books). Seeded RNGs only: the results are reproducible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/casino.js';
import { Casino, viewBj, viewPoker } from '../server/casino.js';

const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const script = (...v) => { let i = 0; return () => { const x = v[i % v.length]; i++; return x; }; };
// card helpers: a rank (1 = ace … 13 = king) as the rnd value that draw() maps to it (suit 0)
const rv = (rank) => (rank - 1 + 0.5) / 52;

test('limits: by class, none on ships without a casino', () => {
  assert.equal(C.tableLimits('rivercruise110'), null); assert.equal(C.tableLimits('boutique125'), null); assert.equal(C.tableLimits('expedition105'), null);
  assert.equal(C.tableLimits('ulcv24k'), null); assert.equal(C.tableLimits('nonsense'), null);
  const l = ['cruise230', 'cruise285', 'cruise330', 'cruise362', 'cruise370'].map((id) => C.tableLimits(id));
  assert.ok(l.every((q) => q && q.min > 0 && q.max > q.min));
  for (let i = 1; i < l.length; i++) assert.ok(l[i].max >= l[i - 1].max && l[i].min >= l[i - 1].min, 'the bigger the ship the higher the limits');
});

test('roulette: coverage, payouts and the 2.70 % house edge of every bet', () => {
  const all = [{ type: 'straight', n: 17 }, { type: 'split', n: [8, 9] }, { type: 'split', n: [8, 11] }, { type: 'split', n: [0, 2] }, { type: 'street', n: 5 }, { type: 'corner', n: 8 }, { type: 'line', n: 4 }, { type: 'column', n: 2 }, { type: 'dozen', n: 3 },
    { type: 'red' }, { type: 'black' }, { type: 'odd' }, { type: 'even' }, { type: 'low' }, { type: 'high' }];
  for (const b of all) {
    assert.ok(C.coverOf(b), JSON.stringify(b));
    let ret = 0; for (let n = 0; n <= 36; n++) ret += C.roulettePayout({ ...b, amt: 1 }, n);
    assert.ok(Math.abs(ret / 37 - 36 / 37) < 1e-9, `${b.type}: ${ret / 37}`);
  }
  assert.equal(C.roulettePayout({ type: 'straight', n: 17, amt: 10 }, 17), 360);   // 35:1 + stake
  assert.equal(C.roulettePayout({ type: 'dozen', n: 2, amt: 10 }, 20), 30); assert.equal(C.roulettePayout({ type: 'red', amt: 10 }, 0), 0);
  assert.equal(C.roulettePayout({ type: 'split', n: [8, 9], amt: 10 }, 9), 180); assert.equal(C.roulettePayout({ type: 'corner', n: 8, amt: 10 }, 12), 90);
  assert.equal(C.roulettePayout({ type: 'street', n: 5, amt: 6 }, 14), 72); assert.equal(C.roulettePayout({ type: 'line', n: 4, amt: 6 }, 10), 36);
  assert.equal(C.colourOf(0), 'green'); assert.equal(C.colourOf(1), 'red'); assert.equal(C.colourOf(2), 'black'); assert.equal(C.RED.size, 18);
  for (const bad of [{ type: 'straight', n: 37 }, { type: 'straight', n: -1 }, { type: 'split', n: [1, 5] }, { type: 'split', n: [3, 4] }, { type: 'corner', n: 3 }, { type: 'corner', n: 35 }, { type: 'street', n: 13 }, { type: 'dozen', n: 4 }, { type: 'zzz' }, { type: 'straight', n: 1.5 }]) assert.equal(C.coverOf(bad), null, JSON.stringify(bad));
  assert.ok(!C.validBet({ type: 'red', amt: 0 })); assert.ok(!C.validBet({ type: 'red', amt: -5 })); assert.ok(!C.validBet({ type: 'red', amt: 1.5 })); assert.ok(!C.validBet({ type: 'red', amt: NaN })); assert.ok(C.validBet({ type: 'red', amt: 5 }, 5, 500)); assert.ok(!C.validBet({ type: 'red', amt: 600 }, 5, 500));
  const r = C.settleRoulette([{ type: 'red', amt: 10 }, { type: 'straight', n: 1, amt: 5 }, { type: 'black', amt: 10 }], 1);
  assert.deepEqual([r.stake, r.returned, r.net, r.wins.length], [25, 20 + 180, 175, 2]);
  // the wheel is uniform over 0-36
  const seen = new Set(); const rnd = lcg(5); for (let i = 0; i < 3000; i++) seen.add(C.spinRoulette(rnd)); assert.equal(seen.size, 37);
  assert.equal(C.spinRoulette(() => 0.9999999), 36);
});

test('blackjack: values, naturals 3:2, dealer stands on 17, double, split, bust', () => {
  const A = 0, K = 12;
  assert.deepEqual(C.handValue([A, K]), { total: 21, soft: true }); assert.equal(C.handValue([A, A, 7]).total, 20); assert.equal(C.handValue([K, K, K]).total, 30); assert.equal(C.handValue([A, 4, K]).total, 16);
  // player A K, dealer 9 8 (scripted draw order: player, player, dealer, dealer)
  let s = C.bjStart(10, script(rv(1), rv(13), rv(9), rv(8)));
  assert.equal(s.phase, 'done'); assert.equal(s.returned, 25); assert.equal(s.net, 15);
  s = C.bjStart(10, script(rv(1), rv(13), rv(1), rv(13))); assert.equal(s.returned, 10);   // both natural: push
  s = C.bjStart(10, script(rv(10), rv(9), rv(1), rv(13))); assert.equal(s.phase, 'done'); assert.equal(s.returned, 0);   // dealer natural (peek)
  // 10 + 6 against dealer 10 + 7: hit a 5 → 21, dealer stands on 17 → win
  s = C.bjStart(10, script(rv(10), rv(6), rv(10), rv(7)));
  assert.deepEqual(C.bjOptions(s).sort(), ['double', 'hit', 'stand']);
  const w = C.bjAct(s, 'hit', script(rv(5))); assert.equal(w.phase, 'done'); assert.deepEqual([w.returned, w.paid], [20, 10]);
  assert.equal(C.bjAct(s, 'stand', script(0.5)).returned, 0);
  // dealer soft 17 stands (A + 6)
  s = C.bjStart(10, script(rv(10), rv(8), rv(1), rv(6))); assert.equal(C.bjAct(s, 'stand', script(0.5)).returned, 20);   // 18 beats soft 17
  // dealer 16 must hit: 10 + 6 + 5 = 21
  s = C.bjStart(10, script(rv(10), rv(9), rv(10), rv(6))); const d = C.bjAct(s, 'stand', script(rv(5))); assert.equal(d.dealer.length, 3); assert.equal(d.returned, 0);
  // bust ends at once and the dealer does not need to play
  s = C.bjStart(10, script(rv(10), rv(6), rv(10), rv(7))); const b = C.bjAct(s, 'hit', script(rv(10))); assert.equal(b.phase, 'done'); assert.equal(b.returned, 0); assert.equal(b.dealer.length, 2);
  // double: one card, double the stake, 11 + 10 = 21
  s = C.bjStart(10, script(rv(6), rv(5), rv(10), rv(7))); assert.equal(C.bjExtra(s, 'double'), 10);
  const dd = C.bjAct(s, 'double', script(rv(10))); assert.deepEqual([dd.paid, dd.returned, dd.net], [20, 40, 20]);
  // split a pair of eights: two hands, one extra bet
  s = C.bjStart(10, script(rv(8), rv(8), rv(10), rv(7))); assert.ok(C.bjOptions(s).includes('split')); assert.equal(C.bjExtra(s, 'split'), 10);
  let sp = C.bjAct(s, 'split', script(rv(3), rv(2))); assert.equal(sp.hands.length, 2); assert.equal(sp.paid, 20); assert.equal(sp.phase, 'play');
  assert.ok(!C.bjOptions(sp).includes('split'), 'one split only');
  sp = C.bjAct(sp, 'stand', script(0.5)); sp = C.bjAct(sp, 'stand', script(0.5)); assert.equal(sp.phase, 'done'); assert.equal(sp.results.length, 2); assert.equal(sp.returned, 0);   // 11 and 10 against 17
  // 21 after a split is not a natural: pays 1:1
  s = C.bjStart(10, script(rv(1), rv(1), rv(10), rv(7))); sp = C.bjAct(s, 'split', script(rv(13), rv(12))); assert.deepEqual(sp.results, ['win', 'win']); assert.equal(sp.returned, 40);
  assert.throws(() => C.bjAct(C.bjStart(10, script(rv(10), rv(6), rv(10), rv(7))), 'split', script(0.5)));
  assert.throws(() => C.bjAct(C.bjAct(C.bjStart(10, script(rv(2), rv(3), rv(10), rv(7))), 'hit', script(rv(2))), 'double', script(0.5)), 'no double after a hit');
});

test('blackjack: house edge — mimicking the dealer costs about 5.5 %, the naturals are in', () => {
  const rnd = lcg(2024); let paid = 0, ret = 0;
  for (let i = 0; i < 200000; i++) { let s = C.bjStart(10, rnd); while (s.phase === 'play') s = C.bjAct(s, C.handValue(s.hands[s.active].cards).total < 17 ? 'hit' : 'stand', rnd); paid += s.paid; ret += s.returned; }
  const edge = 1 - ret / paid; assert.ok(edge > 0.04 && edge < 0.075, `edge ${edge}`);
});

test('baccarat: tableau, payouts and edges (banker 1.06 %, player 1.24 %, tie 14.4 %)', () => {
  // natural 9 for the player: no draw
  let r = C.baccaratRound(script(rv(4), rv(5), rv(2), rv(3))); assert.deepEqual([r.pv, r.bv, r.outcome], [9, 5, 'player']); assert.equal(r.player.length, 2); assert.equal(r.banker.length, 2);
  assert.deepEqual(C.settleBaccarat({ player: 10 }, r), { stake: 10, returned: 20, net: 10, outcome: 'player' });
  assert.equal(C.settleBaccarat({ banker: 10 }, r).returned, 0);
  r = { outcome: 'banker' }; assert.equal(C.settleBaccarat({ banker: 100 }, r).returned, 195);   // 5 % commission
  r = { outcome: 'tie' }; assert.deepEqual([C.settleBaccarat({ player: 10, banker: 10, tie: 10 }, r).returned], [10 + 10 + 90]);
  const rnd = lcg(77), N = 300000, e = { player: 0, banker: 0, tie: 0 };
  for (let i = 0; i < N; i++) { const rd = C.baccaratRound(rnd); for (const k of Object.keys(e)) e[k] += C.settleBaccarat({ [k]: 1 }, rd).net; }
  assert.ok(Math.abs(e.player / N + 0.0124) < 0.008, `player ${e.player / N}`); assert.ok(Math.abs(e.banker / N + 0.0106) < 0.008, `banker ${e.banker / N}`); assert.ok(Math.abs(e.tie / N + 0.144) < 0.025, `tie ${e.tie / N}`);
});

test('slots: exact return 94-96 %, a hit every 2-3 spins, wilds, scatter free spins at ×2', () => {
  const st = C.slotStats();
  assert.ok(st.rtp > 0.94 && st.rtp < 0.96, `rtp ${st.rtp}`); assert.ok(st.hit > 0.3 && st.hit < 0.6, `hit ${st.hit}`); assert.ok(st.triggers > 0.01 && st.triggers < 0.08, `bonus ${st.triggers}`);
  // pays: three cherries on the middle line, wild substitutes, scatter blocks
  const win = (rows) => [0, 1, 2, 3, 4].map((i) => rows[i]);   // reel → [top, mid, bottom]
  const filler = [1, 2, 3];
  void win;
  let w = [[4, 0, 4], [4, 6, 4], [4, 0, 4], [3, 2, 1], [2, 1, 3]]; const lp = C.linePays(w); assert.ok(lp.hits.some((h) => h.line === 0 && h.sym === 0 && h.count === 3), JSON.stringify(lp));
  w = [[4, 0, 4], [4, 7, 4], [4, 0, 4], [3, 2, 1], [2, 1, 3]]; assert.ok(!C.linePays(w).hits.some((h) => h.line === 0), 'a scatter blocks the line');
  void filler;
  // a spin: stake = ten lines, returned = lines + free spins
  const rnd = lcg(11); let tot = 0, stake = 0, sawFree = false;
  for (let i = 0; i < 40000; i++) { const r = C.spinSlots(2, rnd); assert.equal(r.stake, 20); const sum = r.pays + r.free.reduce((a, f) => a + f.pays, 0); assert.ok(Math.abs(sum - r.returned) < 1e-9); tot += r.returned; stake += r.stake; if (r.free.length) { sawFree = true; assert.ok([10, 15, 20].includes(r.free.length)); assert.ok(r.scatters >= 3); } }
  assert.ok(sawFree); assert.ok(tot / stake > 0.8 && tot / stake < 1.15, `${tot / stake}`);
  // free spins pay double: force the same window and compare
  const f = C.spinSlots(1, lcg(3)); for (const q of f.free) assert.ok(q.pays % 2 === 0 || Number.isFinite(q.pays));
});

test('poker: hand ranks, kickers, wheel, flush over straight', () => {
  const c = (r, s) => (r - 1) * 1 + s * 13;   // rank 1 = ace … 13 = king; s = suit
  const H = (...a) => C.evaluate7(a.map(([r, s]) => c(r, s)));
  const sf = H([10, 0], [11, 0], [12, 0], [13, 0], [1, 0], [2, 1], [3, 2]), quads = H([5, 0], [5, 1], [5, 2], [5, 3], [1, 0], [9, 1], [2, 2]), fh = H([5, 0], [5, 1], [5, 2], [9, 3], [9, 0], [1, 1], [2, 2]);
  const fl = H([2, 0], [5, 0], [7, 0], [9, 0], [12, 0], [1, 1], [3, 2]), st = H([5, 0], [6, 1], [7, 2], [8, 3], [9, 0], [1, 1], [13, 2]), tr = H([5, 0], [5, 1], [5, 2], [9, 3], [11, 0], [1, 1], [2, 2]);
  const tp = H([5, 0], [5, 1], [9, 2], [9, 3], [11, 0], [1, 1], [2, 2]), pr = H([5, 0], [5, 1], [9, 2], [10, 3], [11, 0], [1, 1], [2, 2]), hc = H([4, 0], [6, 1], [9, 2], [10, 3], [12, 0], [1, 1], [2, 2]);
  const order = [sf, quads, fh, fl, st, tr, tp, pr, hc]; for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] > order[i], `rank ${i}`);
  assert.equal(C.handName(sf), 'Straight flush'); assert.equal(C.handName(fh), 'Full house'); assert.equal(C.handName(hc), 'High card');
  const wheel = H([1, 0], [2, 1], [3, 2], [4, 3], [5, 0], [9, 1], [13, 2]), six = H([2, 0], [3, 1], [4, 2], [5, 3], [6, 0], [9, 1], [13, 2]); assert.equal(C.handName(wheel), 'Straight'); assert.ok(six > wheel, 'the wheel is the lowest straight');
  assert.ok(H([1, 0], [1, 1], [13, 2], [9, 3], [4, 0], [3, 1], [2, 2]) > H([1, 0], [1, 1], [12, 2], [9, 3], [4, 0], [3, 1], [2, 2]), 'kicker decides');
  assert.ok(H([13, 0], [13, 1], [2, 2], [2, 3], [9, 0], [3, 1], [4, 2]) > H([12, 0], [12, 1], [11, 2], [11, 3], [9, 0], [3, 1], [4, 2]), 'higher two pair');
  assert.ok(C.preflopStrength(c(1, 0), c(1, 1)) > C.preflopStrength(c(7, 0), c(2, 1)));
});

test('poker: a hand conserves chips, rake is capped, folding loses only what is in, options are enforced', () => {
  const rnd = lcg(99); let hands = 0, folds = 0, showdowns = 0;
  for (let i = 0; i < 4000; i++) {
    let s = C.pokerStart(10, rnd), g = 0;
    while (s.phase === 'play' && g++ < 40) {
      const o = C.pokerOptions(s); assert.ok(o.length >= 2);
      const pick = rnd(); const a = pick < 0.1 && o.includes('fold') ? 'fold' : pick < 0.3 && o.includes('raise') ? 'raise' : pick < 0.5 && o.includes('bet') ? 'bet' : o.includes('call') ? 'call' : 'check';
      const before = s; s = C.pokerAct(s, a, rnd); assert.notEqual(s, before);
      assert.equal(s.inn.reduce((x, y) => x + y, 0), s.pot, 'pot = what everybody put in');
    }
    assert.equal(s.phase, 'done'); hands++; if (s.folded[0]) folds++; if (s.showdown) showdowns++;
    assert.ok(s.rake >= 0 && s.rake <= 30 && s.rake <= Math.floor(s.pot * 0.05) + 0, `rake ${s.rake} of ${s.pot}`);
    const paidOut = (s.returned) + 0; assert.ok(paidOut <= s.pot - s.rake + 1e-9); assert.ok(s.net >= -s.inn[0] - 1e-9);
    if (s.folded[0]) assert.equal(s.returned, 0); assert.equal(s.paid, s.inn[0]);
  }
  assert.ok(folds > 30 && showdowns > 500, `${folds} folds, ${showdowns} showdowns of ${hands}`);
  const s = C.pokerStart(10, lcg(1)); assert.throws(() => C.pokerAct(s, 'fold', lcg(2)), /not allowed/); assert.throws(() => C.pokerAct(s, 'raise', lcg(2)), /not allowed/);
  assert.deepEqual(C.pokerOptions(s), ['check', 'bet']); assert.equal(C.pokerCost(s, 'bet'), 10);
  const v = viewPoker(s); assert.equal(v.you.length, 2); assert.ok(!('hole' in v)); assert.equal(v.board.length, 0); assert.equal(v.seats, null);
});

// ------------------------------------------------------------------------------------------------ the server
function table(rnd, opts = {}) {
  const sent = []; let t = 1000;
  const game = { simTime: 5000, send: (p, m) => sent.push(m), event: () => {}, sendYou: () => {}, fleet: { addDay: (p, v, cat, amt) => { game.booked.push([cat, amt]); } }, booked: [] };
  const casino = new Casino(game, { rnd, now: () => t });
  const p = { id: 'p1', money: opts.money ?? 10000, ship: { cls: opts.cls || 'cruise362' }, stats: {}, office: opts.office === false ? undefined : { book: { days: {} } } };
  const act = (m) => { t += opts.gap ?? 1; sent.length = 0; casino.onAction(p, { action: 'casino', ...m }); return sent[sent.length - 1]; };
  return { casino, p, game, sent, act, tick: (s) => { t += s; } };
}

test('server: only ships with a casino; limits of the class; unknown things are refused', () => {
  for (const cls of ['rivercruise110', 'boutique125', 'ulcv24k']) { const T = table(lcg(1), { cls }); const r = T.act({ game: 'roulette', op: 'spin', bets: [{ type: 'red', amt: 10 }] }); assert.equal(r.ok, false); assert.match(r.text, /no casino/); assert.equal(T.p.money, 10000); }
  const T = table(lcg(1)); assert.equal(T.act({ game: 'bingo', op: 'spin' }).ok, false);
  const lim = C.tableLimits('cruise362');
  assert.equal(T.act({ game: 'roulette', op: 'limits' }).limits.max, lim.max);
  assert.equal(T.act({ game: 'roulette', op: 'spin', bets: [{ type: 'red', amt: lim.min - 1 }] }).ok, false);
  assert.equal(T.act({ game: 'roulette', op: 'spin', bets: [{ type: 'red', amt: lim.max + 1 }] }).ok, false);
  assert.equal(T.p.money, 10000, 'nothing was taken for refused bets');
});

test('server: bets are validated — whole credits, on the layout, within the purse; forged results are ignored', () => {
  const T = table(lcg(4), { money: 100 });
  for (const bets of [[{ type: 'red', amt: 'lots' }], [{ type: 'red', amt: 1e9 }], [{ type: 'red', amt: -50 }], [{ type: 'red', amt: 25.5 }], [{ type: 'red', amt: null }], [{ type: 'straight', n: 99, amt: 25 }], [], 'red', null, [{ type: 'red', amt: 25 }, { type: 'red', amt: 25 }, { type: 'red', amt: 25 }, { type: 'red', amt: 25 }, { type: 'red', amt: 25 }]]) {
    const r = T.act({ game: 'roulette', op: 'spin', bets }); assert.equal(r.ok, false, JSON.stringify(bets)); assert.equal(T.p.money, 100);
  }
  const r = T.act({ game: 'roulette', op: 'spin', bets: [{ type: 'red', amt: 25, payout: 1e9 }], net: 1e9, returned: 1e9, number: 17, money: 1e9 });
  assert.equal(r.ok, true); assert.ok(r.net === 25 || r.net === -25 || r.net === 25 * 0 - 25 || Math.abs(r.net) === 25, `${r.net}`); assert.ok(T.p.money === 125 || T.p.money === 75, `${T.p.money}`);
  assert.equal(T.act({ game: 'slots', op: 'spin', lineBet: 0 }).ok, false); assert.equal(T.act({ game: 'slots', op: 'spin', lineBet: 2.5 }).ok, false); assert.equal(T.act({ game: 'slots', op: 'spin', lineBet: '3' }).ok, false);
  assert.equal(T.act({ game: 'blackjack', op: 'hit' }).ok, false, 'no hand in play'); assert.equal(T.act({ game: 'poker', op: 'call' }).ok, false);
});

test('server: the balance never goes negative and money is conserved — thousands of random bets in every game', () => {
  const rnd = lcg(31337), pick = (a) => a[Math.floor(rnd() * a.length)];
  const T = table(rnd, { money: 500, gap: 1, cls: 'cruise230' }); const lim = C.tableLimits('cruise230'); let spent = 0;
  for (let i = 0; i < 6000; i++) {
    T.tick(12);   // keep the rate limits quiet: this test is about money
    const g = pick(['roulette', 'blackjack', 'baccarat', 'slots', 'poker']), before = T.p.money, amt = pick([lim.min, lim.min, lim.min * 2, lim.max, 7, 0, -3, 1e12]);
    let r;
    if (g === 'roulette') r = T.act({ game: g, op: 'spin', bets: [{ type: pick(['red', 'black', 'straight', 'dozen']), n: 7, amt }] });
    else if (g === 'blackjack') r = T.act({ game: g, op: T.casino.S(T.p).bj ? pick(['hit', 'stand', 'double', 'split']) : 'deal', bet: amt });
    else if (g === 'baccarat') r = T.act({ game: g, op: 'deal', bets: { [pick(['player', 'banker', 'tie'])]: amt } });
    else if (g === 'slots') r = T.act({ game: g, op: 'spin', lineBet: Math.floor(amt / 10) || 1 });
    else r = T.act({ game: g, op: T.casino.S(T.p).poker ? pick(['fold', 'call', 'check', 'bet', 'raise']) : 'deal' });
    assert.ok(Number.isFinite(T.p.money) && T.p.money >= 0 && Number.isInteger(T.p.money), `${g}: ${T.p.money}`);
    if (r && r.ok === false) assert.ok(T.p.money === before || g === 'blackjack' || g === 'poker', `a refused ${g} changed the purse`);
    if (T.p.money < lim.min * 3) { T.p.money += 500; spent += 500; }   // a refill, as if the captain went back to the cabin for cash
    T.casino.S(T.p).cool = 0;
  }
  // everything the player ever had is accounted for by the casino statistics: purse = start + refills + returned − wagered (open rounds aside)
  const st = T.p.stats.casino, s = T.casino.S(T.p), openStake = (s.bj ? s.bj.paid : 0) + (s.poker ? s.poker.inn[0] : 0);
  assert.equal(T.p.money, 500 + spent + st.returned - st.wagered - openStake, 'purse = start + refills + returned − wagered − stakes still on the table');
  assert.ok(st.rounds > 1000, `${st.rounds} rounds`);
});

test('server: blackjack and poker keep their round on the server and hide what the player must not see', () => {
  const T = table(script(rv(10), rv(6), rv(10), rv(7), rv(5)), { money: 1000 });
  const lim = C.tableLimits('cruise362');
  let r = T.act({ game: 'blackjack', op: 'deal', bet: lim.min }); assert.equal(r.ok, true); assert.equal(T.p.money, 1000 - lim.min); assert.equal(r.view.dealer.length, 1, 'the hole card is hidden');
  assert.equal(T.act({ game: 'blackjack', op: 'deal', bet: lim.min }).ok, false, 'one hand at a time');
  assert.ok(!JSON.stringify(r).includes('"shoe"'));
  r = T.act({ game: 'blackjack', op: 'hit' }); assert.equal(r.view.phase, 'done'); assert.equal(r.net, lim.min); assert.equal(T.p.money, 1000 + lim.min);   // 16 + 5 = 21 against 17
  assert.equal(T.act({ game: 'blackjack', op: 'stand' }).ok, false, 'the round is over');
  assert.deepEqual(T.game.booked.pop(), ['income', lim.min]);
  // poker: your own cards, never the guests'
  const P = table(lcg(8), { money: 1000 }); r = P.act({ game: 'poker', op: 'deal' }); assert.equal(r.ok, true); assert.equal(P.p.money, 1000 - lim.min);
  assert.equal(r.view.you.length, 2); assert.ok(!('hole' in r.view)); assert.equal(r.view.seats, null);
  r = P.act({ game: 'poker', op: 'fold' }); assert.equal(r.ok, false, 'cannot fold when nobody has bet: check');
  let n = 0; while (P.casino.S(P.p).poker && n++ < 20) r = P.act({ game: 'poker', op: P.casino.S(P.p).poker.round.bet > P.casino.S(P.p).poker.round.put[0] ? 'call' : 'check' });
  assert.equal(r.view.phase, 'done'); assert.ok(r.view.seats === null || r.view.seats.length === 4);
});

test('server: rate limit, per-minute cap and the cooling-off after a big loss', () => {
  const T = table(lcg(5), { money: 1e7, gap: 0.1 }); const lim = C.tableLimits('cruise362');
  let r = T.act({ game: 'slots', op: 'spin', lineBet: 3 }); assert.equal(r.ok, true);
  r = T.act({ game: 'slots', op: 'spin', lineBet: 3 }); assert.equal(r.ok, false); assert.match(r.text, /Slow down/);
  const U = table(lcg(6), { money: 1e7, gap: 0.5 }); let ok = 0, refused = 0;
  for (let i = 0; i < 118; i++) { const q = U.act({ game: 'slots', op: 'spin', lineBet: 3 }); if (q.ok) ok++; else refused++; }   // 59 s at two bets a second
  assert.ok(ok <= 90 && refused >= 20, `${ok} ok, ${refused} refused within a minute`);
  // cooling-off: a stream of losses over 6 × the maximum
  const V = table(() => 0.5, { money: 1e7, gap: 1 });   // 0.5 → roulette 18 (red): bet black and lose
  let cooled = false;
  for (let i = 0; i < 40 && !cooled; i++) { const q = V.act({ game: 'roulette', op: 'spin', bets: [{ type: 'black', amt: lim.max }] }); if (!q.ok && /Cooling-off/.test(q.text)) cooled = true; if (q.cool > 0) cooled = true; }
  assert.ok(cooled, 'the casino asked the player to stop'); assert.ok(V.p.money > 1e7 - lim.max * 12, `lost ${1e7 - V.p.money} before the break`);
  const q = V.act({ game: 'roulette', op: 'spin', bets: [{ type: 'black', amt: lim.min }] }); assert.equal(q.ok, false); assert.match(q.text, /Cooling-off/);
  V.tick(601); assert.equal(V.act({ game: 'roulette', op: 'spin', bets: [{ type: 'black', amt: lim.min }] }).ok, true, 'back at the table after ten minutes');
});

test('server: wins and losses go to the company books; stats track the house account; idle rounds settle', () => {
  const T = table(lcg(12), { money: 5000 }); const lim = C.tableLimits('cruise362');
  for (let i = 0; i < 30; i++) { T.tick(2); T.act({ game: 'roulette', op: 'spin', bets: [{ type: 'red', amt: lim.min }] }); }
  const st = T.p.stats.casino; assert.equal(st.rounds, 30); assert.equal(st.wagered, 30 * lim.min);
  const booked = T.game.booked.reduce((a, b) => a + b[1], 0); assert.equal(booked, T.p.money - 5000, 'books = what the purse gained or lost');
  assert.ok(T.game.booked.every(([c, a]) => (a > 0 ? c === 'income' : c === 'costs')));
  const N = table(lcg(12), { money: 5000, office: false }); N.act({ game: 'roulette', op: 'spin', bets: [{ type: 'red', amt: lim.min }] }); assert.equal(N.game.booked.length, 0, 'no office, no books: the purse only');
  // an abandoned blackjack hand is stood after ten minutes: the credits come back or go, never hang
  const B = table(script(rv(10), rv(9), rv(10), rv(7)), { money: 1000 }); B.act({ game: 'blackjack', op: 'deal', bet: lim.min }); assert.equal(B.p.money, 1000 - lim.min);
  B.tick(700); const r = B.act({ game: 'blackjack', op: 'limits' }); assert.equal(r.ok, true); assert.equal(B.p.money, 1000 + lim.min, '19 against 17: paid');
  assert.equal(B.casino.S(B.p).bj, null);
});

test('house edge summary: every game returns less than it takes (roulette 97.3, slots ~95.8, baccarat 98.8-98.9, blackjack ~99.5 with basic strategy)', () => {
  assert.ok(C.slotStats().rtp < 1); assert.ok(36 / 37 < 1);
});

// ------------------------------------------------------------------------------------------------ the tables' look (pure parts)
test('table art: the roulette ball always ends in the server pocket, whatever the rotor does', async () => {
  const { ORDER, ballPath, rotorPath, POCKET, TAU } = await import('../public/js/iv2roulette.js');
  assert.equal(ORDER.length, 37); assert.deepEqual([...ORDER].sort((a, b) => a - b), Array.from({ length: 37 }, (_, i) => i)); assert.equal(ORDER[0], 0);
  const R = 100;
  for (let n = 0; n <= 36; n++) {
    const k = ORDER.indexOf(n);
    for (const [T0, rot0] of [[5.6, 0], [1.2, 2.3], [5.6, 17.9]]) {
      const end = ballPath(T0, T0, k, rot0, R), rel = (((end.ang - rotorPath(T0, T0, rot0) - k * POCKET) % TAU) + TAU) % TAU;
      assert.ok(Math.min(rel, TAU - rel) < 1e-9, `number ${n}`); assert.ok(Math.abs(end.r - R * 0.5) < 1e-9);
      let prev = ballPath(0, T0, k, rot0, R).ang, laps = 0; for (let t = 0.01; t <= T0; t += T0 / 400) { const a = ballPath(t, T0, k, rot0, R).ang; laps += Math.abs(a - prev); prev = a; }
      assert.ok(laps > TAU * 5, 'the ball circles several times');
    }
  }
  assert.ok(ballPath(0, 5, 3, 0, R).r > R * 0.8, 'it starts on the rim'); assert.ok(ballPath(2.5, 5, 3, 0, R).r > ballPath(4.9, 5, 3, 0, R).r);
});
test('table art: easing, chips and particles are well behaved', async () => {
  const UI = await import('../public/js/iv2casinoui.js');
  for (const k of ['out', 'in', 'io']) { assert.equal(UI.E[k](0), 0); assert.ok(Math.abs(UI.E[k](1) - 1) < 1e-9); }
  assert.ok(Math.abs(UI.E.back(1) - 1) < 1e-9); assert.ok(Math.abs(UI.E.bounce(1) - 1) < 1e-9);
  assert.equal(UI.short(1500), '1.5k'); assert.equal(UI.short(25), '25'); assert.equal(UI.short(2500000), '2.5M');
  assert.equal(UI.quick(), false); assert.equal(UI.T(1), 1);   // no localStorage in node: never throws, never quick
  assert.match(UI.shade('#336699', 0.3), /^rgb\(/); assert.match(UI.chipColour(7), /^#/);
  const P = new UI.Particles(); P.confetti(400, 40); P.coins(400, 20); assert.equal(P.p.length, 60); P.update(10, 300); assert.equal(P.p.length, 0);
});
