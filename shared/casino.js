// The casino of a cruise ship (docs/CRUISE-CONTRACT.md §7): the rules of the games, pure and deterministic given an RNG, shared by
// the server (server/casino.js: the only place a game is rolled, paid and booked) and the client (public/js/iv2casino.js shows
// what the server answered). Credits only: the game has no real money. No DOM, no Math.random: every function takes `rnd()`
// → [0, 1). Payout functions return the TOTAL RETURNED to the player (stake included; 0 on a loss), so the net is returned − stake.
//
//   tableLimits(cls)                      { min, max } of a cruise class (null: the ship has no casino)
//   roulette:  spinRoulette, validBet, roulettePayout, settleRoulette        European wheel, one zero, house edge 2.70 %
//   blackjack: bjStart, bjAct, handValue                                      6-deck-like infinite shoe, dealer stands on all 17s,
//                                                                             3:2 naturals, double on two cards, one split
//   baccarat:  baccaratRound, settleBaccarat                                  player 1:1, banker 0.95:1, tie 8:1
//   slots:     spinSlots, slotStats                                           5 reels × 3 rows, 10 lines, wild, scatter free spins
//   poker:     pokerStart, pokerAct, evaluate7                                Texas hold'em, limit betting, you against 3 guests
import { cruiseClassOf, cruiseProfile } from './ships/cruiseprofile.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r0 = (v) => Math.floor(v + 1e-9);

// ------------------------------------------------------------------------------------------------ limits
/** Table limits by cruise class (cr per bet; Game rule). The small ships have no casino. */
export const LIMITS = Object.freeze({ mid: { min: 5, max: 500 }, premium: { min: 10, max: 1000 }, large: { min: 10, max: 2000 }, mega: { min: 25, max: 5000 }, giga: { min: 25, max: 10000 } });
/** { min, max } for ship model `cls`, or null when it has no casino. */
export function tableLimits(cls) {
  const c = cruiseClassOf(cls), p = cruiseProfile(cls);
  if (!c || !p || !p.venues.casino || !LIMITS[c]) return null;
  return LIMITS[c];
}
/** Responsible play (Game rule): a table session may lose at most this many × the table max before a 10-minute cooling-off. */
export const PLAY_RULES = Object.freeze({ MIN_GAP_S: 0.5, LOSS_CAP_X: 6, COOLOFF_S: 600, WINDOW_S: 3600, MAX_PER_MIN: 90 });

// ------------------------------------------------------------------------------------------------ roulette
export const RED = Object.freeze(new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]));
export const spinRoulette = (rnd) => Math.floor(rnd() * 37);
export const colourOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
/** Numbers a bet covers, or null when the bet is not valid. bet = { type, n?, amt }. */
export function coverOf(b) {
  const n = b.n;
  switch (b.type) {
    case 'straight': return Number.isInteger(n) && n >= 0 && n <= 36 ? [n] : null;
    case 'split': {
      if (!Array.isArray(n) || n.length !== 2 || !n.every((q) => Number.isInteger(q) && q >= 0 && q <= 36)) return null;
      const [a, c] = [...n].sort((x, y) => x - y);
      if (a === c) return null;
      if (a === 0) return c <= 3 ? [0, c] : null;
      return (c - a === 3) || (c - a === 1 && Math.ceil(a / 3) === Math.ceil(c / 3)) ? [a, c] : null;
    }
    case 'street': return Number.isInteger(n) && n >= 1 && n <= 12 ? [3 * n - 2, 3 * n - 1, 3 * n] : null;
    case 'corner': return Number.isInteger(n) && n >= 1 && n <= 32 && n % 3 !== 0 ? [n, n + 1, n + 3, n + 4] : null;   // n = lowest number of the square
    case 'line': return Number.isInteger(n) && n >= 1 && n <= 11 ? [3 * n - 2, 3 * n - 1, 3 * n, 3 * n + 1, 3 * n + 2, 3 * n + 3] : null;
    case 'column': return Number.isInteger(n) && n >= 1 && n <= 3 ? Array.from({ length: 12 }, (_, i) => 3 * i + n) : null;
    case 'dozen': return Number.isInteger(n) && n >= 1 && n <= 3 ? Array.from({ length: 12 }, (_, i) => 12 * (n - 1) + 1 + i) : null;
    case 'red': return [...RED];
    case 'black': return Array.from({ length: 36 }, (_, i) => i + 1).filter((q) => !RED.has(q));
    case 'odd': return Array.from({ length: 18 }, (_, i) => 2 * i + 1);
    case 'even': return Array.from({ length: 18 }, (_, i) => 2 * i + 2);
    case 'low': return Array.from({ length: 18 }, (_, i) => i + 1);
    case 'high': return Array.from({ length: 18 }, (_, i) => i + 19);
    default: return null;
  }
}
/** Winnings per unit staked (the payout "x to 1") of a bet by the numbers it covers: 36 / n − 1. */
export const oddsOf = (b) => { const c = coverOf(b); return c ? 36 / c.length - 1 : 0; };
export const validBet = (b, min = 1, max = Infinity) => !!b && Number.isFinite(b.amt) && Number.isInteger(b.amt) && b.amt >= min && b.amt <= max && !!coverOf(b);
/** Total returned by one bet when the ball lands on `n`. */
export function roulettePayout(b, n) { const c = coverOf(b); if (!c || !c.includes(n)) return 0; return b.amt * (36 / c.length); }
/** { stake, returned, net, wins } of a list of bets on one spin. */
export function settleRoulette(bets, n) {
  let stake = 0, returned = 0; const wins = [];
  for (const b of bets) { stake += b.amt; const r = roulettePayout(b, n); returned += r; if (r) wins.push(b); }
  return { stake, returned, net: returned - stake, wins, number: n, colour: colourOf(n) };
}

// ------------------------------------------------------------------------------------------------ cards
// A card is 0..51: rank = c % 13 (0 ace, 1..8 = 2..9, 9..12 = ten, jack, queen, king), suit = floor(c / 13).
export const rankOf = (c) => c % 13, suitOf = (c) => Math.floor(c / 13);
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SUITS = ['♠', '♥', '♦', '♣'];
export const cardName = (c) => RANKS[rankOf(c)] + SUITS[suitOf(c)];
const draw = (rnd) => Math.floor(rnd() * 52);   // an endless shoe: every card has probability 1/52 whatever was dealt (the house edge of a 6-8 deck shoe to 0.01 %)

// ------------------------------------------------------------------------------------------------ blackjack
/** { total, soft } of a hand (aces count 11 while that does not bust). */
export function handValue(cards) {
  let t = 0, aces = 0;
  for (const c of cards) { const r = rankOf(c); if (r === 0) { aces++; t += 11; } else t += r >= 9 ? 10 : r + 1; }
  while (t > 21 && aces > 0) { t -= 10; aces--; }
  return { total: t, soft: aces > 0 };
}
const isNatural = (cards) => cards.length === 2 && handValue(cards).total === 21;
const bjVal = (c) => (rankOf(c) === 0 ? 11 : rankOf(c) >= 9 ? 10 : rankOf(c) + 1);
/** Start a round: { bet, hands: [{ cards, bet, done, doubled, split }], active, dealer: [up, hole], phase, returned? }. Dealer peeks for a natural. */
export function bjStart(bet, rnd) {
  const s = { bet, hands: [{ cards: [draw(rnd), draw(rnd)], bet, done: false, doubled: false, split: false }], active: 0, dealer: [draw(rnd), draw(rnd)], phase: 'play', paid: bet, result: null };
  const pn = isNatural(s.hands[0].cards), dn = isNatural(s.dealer);
  if (pn || dn) return finish(s, rnd, true);
  return s;
}
/** What the player may do now. */
export function bjOptions(s) {
  if (s.phase !== 'play') return [];
  const h = s.hands[s.active], o = ['hit', 'stand'];
  if (h.cards.length === 2 && !h.doubled) o.push('double');
  if (h.cards.length === 2 && s.hands.length === 1 && bjVal(h.cards[0]) === bjVal(h.cards[1])) o.push('split');
  return o;
}
/** Extra stake an action needs (double / split: another bet). */
export const bjExtra = (s, action) => (s.phase === 'play' && (action === 'double' || action === 'split') ? s.hands[s.active].bet : 0);
/** Apply `action` ('hit' | 'stand' | 'double' | 'split') and return the new state (the old one is not modified). */
export function bjAct(s0, action, rnd) {
  if (s0.phase !== 'play') return s0;
  if (!bjOptions(s0).includes(action)) throw new Error(`bj: ${action} not allowed`);
  const s = JSON.parse(JSON.stringify(s0)), h = s.hands[s.active];
  if (action === 'hit') { h.cards.push(draw(rnd)); if (handValue(h.cards).total >= 21) h.done = true; }
  else if (action === 'stand') h.done = true;
  else if (action === 'double') { s.paid += h.bet; h.bet *= 2; h.doubled = true; h.cards.push(draw(rnd)); h.done = true; }
  else if (action === 'split') {
    const [a, b] = h.cards; s.paid += h.bet;
    s.hands = [{ cards: [a, draw(rnd)], bet: h.bet, done: false, doubled: false, split: true }, { cards: [b, draw(rnd)], bet: h.bet, done: false, doubled: false, split: true }];
    if (rankOf(a) === 0) for (const q of s.hands) q.done = true;   // split aces get one card each
    s.active = 0;
  }
  // next unfinished hand, or the dealer plays
  while (s.active < s.hands.length && s.hands[s.active].done) s.active++;
  if (s.active >= s.hands.length) { s.active = s.hands.length - 1; return finish(s, rnd, false); }
  return s;
}
function finish(s, rnd, initial) {
  const d = s.dealer; let returned = 0; const res = [];
  const dn = isNatural(d), live = s.hands.some((h) => handValue(h.cards).total <= 21);
  if (!initial && live && !(s.hands.length === 1 && isNatural(s.hands[0].cards))) while (handValue(d).total < 17) d.push(draw(rnd));   // dealer stands on every 17
  const dv = handValue(d).total;
  for (const h of s.hands) {
    const pv = handValue(h.cards).total, pn = !h.split && isNatural(h.cards);
    let r = 0, why;
    if (pn && dn) { r = h.bet; why = 'push'; }
    else if (pn) { r = h.bet * 2.5; why = 'blackjack'; }   // 3:2
    else if (dn) { r = 0; why = 'dealer blackjack'; }
    else if (pv > 21) { r = 0; why = 'bust'; }
    else if (dv > 21 || pv > dv) { r = h.bet * 2; why = 'win'; }
    else if (pv === dv) { r = h.bet; why = 'push'; }
    else { r = 0; why = 'lose'; }
    returned += r; res.push(why);
  }
  return { ...s, phase: 'done', returned, results: res, net: returned - s.paid };
}

// ------------------------------------------------------------------------------------------------ baccarat
const bacVal = (c) => (rankOf(c) >= 9 ? 0 : rankOf(c) + 1);
const bacTotal = (cards) => cards.reduce((s, c) => s + bacVal(c), 0) % 10;
/** One round with the standard tableau: { player: [cards], banker: [cards], pv, bv, outcome: 'player' | 'banker' | 'tie' }. */
export function baccaratRound(rnd) {
  const p = [draw(rnd), draw(rnd)], b = [draw(rnd), draw(rnd)];
  let pv = bacTotal(p), bv = bacTotal(b);
  if (pv < 8 && bv < 8) {   // no natural: the player draws on 0-5, the banker by the table
    let p3 = null;
    if (pv <= 5) { p3 = draw(rnd); p.push(p3); pv = bacTotal(p); }
    const bd = p3 === null ? bv <= 5 : (() => { const v = bacVal(p3); return bv <= 2 || (bv === 3 && v !== 8) || (bv === 4 && v >= 2 && v <= 7) || (bv === 5 && v >= 4 && v <= 7) || (bv === 6 && (v === 6 || v === 7)); })();
    if (bd) { b.push(draw(rnd)); bv = bacTotal(b); }
  }
  return { player: p, banker: b, pv, bv, outcome: pv > bv ? 'player' : bv > pv ? 'banker' : 'tie' };
}
/** bets = { player, banker, tie } (stakes) → { stake, returned, net }: player 1:1, banker 0.95:1 (5 % commission), tie 8:1, the others push on a tie. */
export function settleBaccarat(bets, round) {
  const bp = bets.player || 0, bb = bets.banker || 0, bt = bets.tie || 0, stake = bp + bb + bt;
  let returned = 0;
  if (round.outcome === 'player') returned = bp * 2;
  else if (round.outcome === 'banker') returned = bb * 1.95;
  else returned = bp + bb + bt * 9;
  return { stake, returned, net: returned - stake, outcome: round.outcome };
}

// ------------------------------------------------------------------------------------------------ slot machine
// 5 reels × 3 rows, 10 fixed lines, symbols 0 cherry · 1 lemon · 2 plum · 3 bell · 4 bar · 5 seven · 6 wild · 7 scatter. Wild pays as
// any symbol but the scatter; 3+ scatters anywhere start free spins (ten at 3, fifteen at 4, twenty at 5) paying ×2.
export const SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '▬', '7', 'W', '★'];
export const LINES = Object.freeze([[1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 1, 1, 1, 0]]);
export const PAYS = Object.freeze({ 0: [0, 0, 2, 5, 15], 1: [0, 0, 2, 5, 15], 2: [0, 0, 4, 8, 25], 3: [0, 0, 5, 15, 40], 4: [0, 0, 8, 25, 80], 5: [0, 0, 15, 60, 250], 6: [0, 0, 15, 60, 250] });
export const FREE_SPINS = Object.freeze({ 3: 10, 4: 15, 5: 20 }), FREE_MULT = 2;
const strip = (spec) => spec.split('').map((c) => Number(c));
// reel strips (symbols by index), 20 stops each; tuned so slotStats().rtp is 94-96 % (about 55 % from the lines, 40 % from the free spins)
export const REELS = Object.freeze([
  strip('03200322765503227104'), strip('05314432166032110654'), strip('27210432176032110654'), strip('43510332176032110654'), strip('03211201765403221034'),
].map((r) => Object.freeze(r)));
const view = (stops) => stops.map((s, i) => { const R = REELS[i], n = R.length; return [R[(s + n - 1) % n], R[s], R[(s + 1) % n]]; });   // rows top / middle / bottom
/** Pay (per unit line bet) of the lines of a window (3 rows × 5 reels, [reel][row]). */
export function linePays(win) {
  let tot = 0; const hits = [];
  LINES.forEach((ln, li) => {
    const sy = ln.map((row, i) => win[i][row]);
    let base = sy.find((q) => q !== 6);   // the first symbol that is not a wild decides the line
    if (base === 7) return;                // a scatter blocks a line
    if (base === undefined) base = 6;      // five wilds
    let k = 0; while (k < 5 && (sy[k] === base || sy[k] === 6)) k++;
    const p = k >= 3 ? PAYS[base][k - 1] : 0;
    if (p) { tot += p; hits.push({ line: li, sym: base, count: k, pay: p }); }
  });
  return { pays: tot, hits };
}
const scatters = (win) => win.reduce((s, col) => s + col.filter((q) => q === 7).length, 0);
/** One spin: { stops, window, pays, hits, scatters, free: [{ window, pays }], returned } for total bet `lineBet × 10`. Free spins are played out at once. */
export function spinSlots(lineBet, rnd) {
  const one = () => { const stops = REELS.map((R) => Math.floor(rnd() * R.length)); const win = view(stops); const lp = linePays(win); return { stops, window: win, pays: lp.pays * lineBet, hits: lp.hits, scatters: scatters(win) }; };
  const main = one(); main.free = [];
  let returned = main.pays;
  const nFree = FREE_SPINS[Math.min(5, main.scatters)] || 0;
  for (let i = 0; i < nFree; i++) { const f = one(); f.pays *= FREE_MULT; main.free.push({ stops: f.stops, window: f.window, pays: f.pays, hits: f.hits }); returned += f.pays; }
  main.returned = returned; main.stake = lineBet * LINES.length; main.freeSpins = nFree;
  return main;
}
/** Exact return to player of the machine by enumerating every stop combination: { rtp, hit, base, free, triggers }. */
export function slotStats() {
  const [a, b, c, d, e] = REELS.map((R) => R.length);
  let base = 0, hit = 0, trig = 0, freeVal = 0, n = 0;
  const pays = []; // line pays of a spin are summed per window; free spins' expectation = (base-line-pay mean) × spins × mult, because free spins use the same reels
  const stops = [0, 0, 0, 0, 0];
  for (let i = 0; i < a; i++) for (let j = 0; j < b; j++) for (let k = 0; k < c; k++) for (let l = 0; l < d; l++) for (let m = 0; m < e; m++) {
    stops[0] = i; stops[1] = j; stops[2] = k; stops[3] = l; stops[4] = m;
    const w = view(stops), lp = linePays(w); n++;
    base += lp.pays; if (lp.pays) hit++;
    const sc = scatters(w); if (sc >= 3) { trig++; pays.push(FREE_SPINS[Math.min(5, sc)]); }
  }
  const meanBase = base / n / LINES.length;   // per unit of total bet
  for (const sp of pays) freeVal += sp * FREE_MULT * meanBase;
  const free = freeVal / n;
  return { rtp: meanBase + free, base: meanBase, free, hit: hit / n, triggers: trig / n, combos: n };
}

// ------------------------------------------------------------------------------------------------ Texas hold'em
const RANK_HI = (c) => (rankOf(c) === 0 ? 14 : rankOf(c) + 1);   // 2..14
/** Score of the best five of up to seven cards: a number that compares hands (category × 15^5 + kickers). */
export function evaluate7(cards) {
  const cnt = new Array(15).fill(0), bySuit = [[], [], [], []];
  for (const c of cards) { const r = RANK_HI(c); cnt[r]++; bySuit[suitOf(c)].push(r); }
  const pack = (arr) => arr.slice(0, 5).reduce((s, r) => s * 15 + r, 0) * 15 ** (5 - Math.min(5, arr.length));
  const straightHigh = (has) => { for (let hi = 14; hi >= 5; hi--) { let ok = true; for (let k = 0; k < 5; k++) { const r = hi - k === 1 ? 14 : hi - k; if (!has[r]) { ok = false; break; } } if (ok) return hi; } return 0; };
  const fl = bySuit.find((s) => s.length >= 5);
  if (fl) { const has = new Array(15).fill(false); fl.forEach((r) => { has[r] = true; }); const sh = straightHigh(has); if (sh) return 8 * 15 ** 5 + sh; }
  const quads = [], trips = [], pairs = [], singles = [];
  for (let r = 14; r >= 2; r--) { if (cnt[r] === 4) quads.push(r); else if (cnt[r] === 3) trips.push(r); else if (cnt[r] === 2) pairs.push(r); else if (cnt[r] === 1) singles.push(r); }
  const kick = (excl, n) => { const out = []; for (let r = 14; r >= 2 && out.length < n; r--) if (cnt[r] && !excl.includes(r)) out.push(r); return out; };
  if (quads.length) return 7 * 15 ** 5 + pack([quads[0], ...kick([quads[0]], 1)]);
  if (trips.length && (trips.length > 1 || pairs.length)) return 6 * 15 ** 5 + pack([trips[0], trips.length > 1 ? trips[1] : pairs[0]]);
  if (fl) return 5 * 15 ** 5 + pack([...fl].sort((x, y) => y - x));
  const has = cnt.map((q) => q > 0), sh = straightHigh(has);
  if (sh) return 4 * 15 ** 5 + sh;
  if (trips.length) return 3 * 15 ** 5 + pack([trips[0], ...kick([trips[0]], 2)]);
  if (pairs.length >= 2) return 2 * 15 ** 5 + pack([pairs[0], pairs[1], ...kick([pairs[0], pairs[1]], 1)]);
  if (pairs.length === 1) return 15 ** 5 + pack([pairs[0], ...kick([pairs[0]], 3)]);
  return pack(kick([], 5));
}
export const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
export const handName = (score) => HAND_NAMES[Math.floor(score / 15 ** 5)] || 'High card';

/** Preflop strength 0..1 of two cards (a Chen-like count). */
export function preflopStrength(a, b) {
  const hi = Math.max(RANK_HI(a), RANK_HI(b)), lo = Math.min(RANK_HI(a), RANK_HI(b));
  let s = hi === 14 ? 10 : hi === 13 ? 8 : hi === 12 ? 7 : hi === 11 ? 6 : hi / 2;
  if (hi === lo) s = Math.max(5, s * 2);
  if (suitOf(a) === suitOf(b)) s += 2;
  const gap = hi - lo - 1; if (hi !== lo) { s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5; if (gap <= 1 && hi < 12) s += 1; }
  return clamp((s + 1) / 20, 0, 1);
}
const POKER_STAGES = ['preflop', 'flop', 'turn', 'river'];
const SEATS = 4;   // seat 0 is the player; 1-3 the guests
/**
 * Start a hand with unit u (the table minimum): everyone antes u; the player's money in is state.in[0]. Bets are u on the preflop and
 * flop, 2u on the turn and river; one bet and one raise per round. Returns { stage, pot, board, hole: [[c, c] × 4], folded, in, bet, ... }.
 */
export function pokerStart(u, rnd) {
  const used = new Set(), take = () => { let c; do { c = draw(rnd); } while (used.has(c)); used.add(c); return c; };
  const hole = Array.from({ length: SEATS }, () => [take(), take()]);
  const board = [take(), take(), take(), take(), take()];
  const s = { u, stage: 0, hole, board, shown: 0, folded: new Array(SEATS).fill(false), inn: new Array(SEATS).fill(u), pot: u * SEATS, toCall: 0, raised: false, round: { bet: 0, put: new Array(SEATS).fill(0), acted: new Array(SEATS).fill(false) }, log: [], phase: 'play', returned: 0, rake: 0, paid: u };
  return s;
}
export const pokerBoard = (s) => s.board.slice(0, s.stage === 0 ? 0 : s.stage + 2);
const strengthOf = (s, seat) => {
  const bd = pokerBoard(s);
  if (!bd.length) return preflopStrength(s.hole[seat][0], s.hole[seat][1]);
  const sc = evaluate7([...s.hole[seat], ...bd]), cat = Math.floor(sc / 15 ** 5);
  return clamp(0.22 + cat * 0.12 + (cat === 1 ? (sc / 15 ** 5 - 1) * 0.12 : 0), 0, 1);
};
/** What the player may do: check / bet (nothing to call) or fold / call / raise. */
export function pokerOptions(s) {
  if (s.phase !== 'play') return [];
  const need = s.round.bet - s.round.put[0];
  return need > 0 ? ['fold', 'call'].concat(s.raised ? [] : ['raise']) : ['check', 'bet'];
}
export const pokerBetSize = (s) => (s.stage >= 2 ? 2 : 1) * s.u;
/** Chips the player must add for `action` now (0 for check / fold). */
export function pokerCost(s, action) {
  const need = s.round.bet - s.round.put[0], b = pokerBetSize(s);
  if (action === 'call') return need; if (action === 'bet') return b; if (action === 'raise') return need + b; return 0;
}
function put(s, seat, amt) { s.round.put[seat] += amt; s.inn[seat] += amt; s.pot += amt; }
function aiAct(s, seat, rnd) {
  const st = strengthOf(s, seat), need = s.round.bet - s.round.put[seat], b = pokerBetSize(s), r = rnd();
  if (need > 0) {
    const call = st + (r - 0.5) * 0.18 > (s.stage === 0 ? 0.32 : 0.36) - (need / s.pot) * 0.0;
    if (!call) { s.folded[seat] = true; s.log.push({ seat, a: 'fold' }); return; }
    if (!s.raised && st > 0.72 && r > 0.35) { put(s, seat, need + b); s.round.bet += b; s.raised = true; s.round.acted.fill(false); s.round.acted[seat] = true; s.log.push({ seat, a: 'raise' }); return; }
    put(s, seat, need); s.log.push({ seat, a: 'call' });
  } else if (st > 0.55 && r > 0.4) { put(s, seat, b); s.round.bet = s.round.put[seat]; s.round.acted.fill(false); s.round.acted[seat] = true; s.log.push({ seat, a: 'bet' }); }
  else s.log.push({ seat, a: 'check' });
}
/** The player's action; the guests answer; the street advances; at the end the pot is paid. Returns the new state (the old one is not modified). */
export function pokerAct(s0, action, rnd, rakePct = 5) {
  if (s0.phase !== 'play') return s0;
  if (!pokerOptions(s0).includes(action)) throw new Error(`poker: ${action} not allowed`);
  const s = JSON.parse(JSON.stringify(s0)), b = pokerBetSize(s), need = s.round.bet - s.round.put[0];
  s.log = [];
  if (action === 'fold') { s.folded[0] = true; s.paid = s.inn[0]; return settle(s, rnd, rakePct); }
  if (action === 'call') put(s, 0, need);
  else if (action === 'bet') { put(s, 0, b); s.round.bet = s.round.put[0]; s.round.acted.fill(false); }
  else if (action === 'raise') { put(s, 0, need + b); s.round.bet += b; s.raised = true; s.round.acted.fill(false); }
  s.round.acted[0] = true;
  // the guests act in turn until everyone left has acted and matched the bet
  for (let guard = 0; guard < 12; guard++) {
    let moved = false;
    for (let seat = 1; seat < SEATS; seat++) {
      if (s.folded[seat]) continue;
      if (s.round.put[seat] === s.round.bet && (s.round.acted[seat] || s.round.bet > 0)) continue;
      aiAct(s, seat, rnd); s.round.acted[seat] = true; moved = true;
    }
    const open = s.round.put[0] < s.round.bet && !s.folded[0];
    if (open) { s.paid = s.inn[0]; return { ...s, owed: s.round.bet - s.round.put[0] }; }   // a guest raised: the player must call or fold
    if (!moved) break;
  }
  return advance(s, rnd, rakePct);
}
function advance(s, rnd, rakePct) {
  s.paid = s.inn[0];
  if (s.stage >= 3) return settle(s, rnd, rakePct);
  const alive = s.folded.filter((f) => !f).length;
  if (alive <= 1) return settle(s, rnd, rakePct);
  s.stage++; s.raised = false; s.round = { bet: 0, put: new Array(SEATS).fill(0), acted: new Array(SEATS).fill(false) };
  return s;
}
function settle(s, rnd, rakePct) {
  s.phase = 'done'; s.stage = Math.max(s.stage, s.folded[0] ? s.stage : 3);
  const alive = [0, 1, 2, 3].filter((q) => !s.folded[q]);
  const bd = s.board;   // showdown on the full board
  let best = -1, winners = [];
  for (const q of alive) { const sc = evaluate7([...s.hole[q], ...bd]); s.hole[q].score = sc; if (sc > best) { best = sc; winners = [q]; } else if (sc === best) winners.push(q); }
  const rake = Math.min(Math.floor(s.pot * rakePct / 100), 3 * s.u);
  const pot = s.pot - rake; s.rake = rake; s.winners = winners; s.scores = alive.map((q) => [q, s.hole[q].score]);
  s.returned = winners.includes(0) ? pot / winners.length : 0;
  s.net = s.returned - s.inn[0]; s.paid = s.inn[0]; s.shown = 5; s.showdown = s.folded[0] ? false : alive.length > 1;
  void rnd;
  return s;
}
export { cardName as nameOf };
