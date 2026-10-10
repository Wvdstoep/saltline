// Cruise ships — the places the captain can use and the guest rating (docs/CRUISE-CONTRACT.md §7): menus by what the ship really has,
// prices charged on the server, the rating from venues, crew, hull and the captain's attention, and its effect on the cruise pay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENUS, menuFor, guestScore, attractionGroups, attentionOf, kindOfItem, ITEM_KIND, CASINO_KINDS } from '../shared/ships/cruisesat.js';
import { Venues, auctionValue } from '../server/venues.js';

const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const IDS = ['rivercruise110', 'boutique125', 'expedition105', 'cruise230', 'cruise285', 'cruise330', 'cruise362', 'cruise370'];

test('menus: only what the ship has; every option has a price and a text', () => {
  for (const id of IDS) for (const k of Object.keys(MENUS)) { const m = menuFor(id, k); if (!m) continue; assert.ok(m.title); for (const o of m.options) { assert.ok(Number.isInteger(o.cost) && o.cost >= 0 && o.id && o.label && o.text, `${id}/${k}/${o.id}`); } }
  assert.equal(menuFor('rivercruise110', 'slide'), null); assert.equal(menuFor('rivercruise110', 'rink'), null); assert.equal(menuFor('cruise362', 'rink')?.options.length, 1);
  assert.ok(menuFor('cruise230', 'bar')); assert.ok(menuFor('cruise230', 'show')); assert.equal(menuFor('cruise230', 'surf'), null); assert.ok(menuFor('cruise370', 'surf'));
  assert.ok(menuFor('cruise362', 'show').options.some((o) => o.id === 'ice'), 'ice show on ships with a rink'); assert.ok(!menuFor('cruise230', 'show').options.some((o) => o.id === 'ice'));
  assert.equal(menuFor('ulcv24k', 'bar'), null); assert.equal(menuFor('cruise362', 'nothing'), null);
  assert.deepEqual(CASINO_KINDS, ['roulette', 'blackjack', 'poker', 'slots', 'baccarat']);
  assert.equal(kindOfItem('roulette'), 'roulette'); assert.equal(kindOfItem('bar_island'), 'bar'); assert.equal(kindOfItem('sofa_bed'), null); assert.ok(Object.keys(ITEM_KIND).length > 30);
});

test('guest rating: more attractions, a serviced crew, an intact hull and a visible captain raise it; the pay follows', () => {
  const base = { cls: 'cruise362', cond: 100, serviceOk: true, visits: null, now: 1000 };
  const g0 = guestScore(base); assert.ok(g0.stars >= 1 && g0.stars <= 5);
  const walk = guestScore({ ...base, visits: { bar: 990, show: 990, dine: 900, spa: 800, casino: 990, shop: 990 } });
  assert.ok(walk.score > g0.score && walk.payMul > g0.payMul && walk.spendMul > g0.spendMul);
  assert.ok(guestScore({ ...base, cond: 40 }).score < g0.score); assert.ok(guestScore({ ...base, serviceOk: false }).score < g0.score);
  assert.ok(attentionOf({ bar: 0 }, 100000) === 0, 'a visit a day old no longer counts'); assert.equal(attentionOf({ bar: 900, show: 950, guest: 990 }, 1000), 2 / 6);
  for (const id of IDS) { const g = guestScore({ cls: id, now: 5 }); assert.ok(g && g.payMul >= 0.8 && g.payMul <= 1.1 && g.spendMul >= 0.75 && g.spendMul <= 1.12, id); assert.ok(attractionGroups(id).length >= 4); }
  const worst = guestScore({ cls: 'cruise362', cond: 0, serviceOk: false }), best = guestScore({ ...base, visits: { a: 1000, b: 1000, c: 1000, d: 1000, e: 1000, f: 1000 } });
  assert.ok(worst.payMul <= 0.9 && best.payMul >= 1.05 && best.stars > worst.stars + 1.4, `${worst.stars} .. ${best.stars}`);
  assert.equal(guestScore({ cls: 'ulcv24k' }), null);
  assert.ok(guestScore({ cls: 'cruise362', now: 5 }).tips.length > 0, 'an unattended ship gets advice');
  // a ship with a gap in its programme says so: the same ship without a casino scores lower on shows
  const g = attractionGroups('cruise362').find((q) => q.group === 'shows'); assert.ok(g.cover > 0.99);
});

function world(opts = {}) {
  const sent = []; const game = { simTime: 7200, send: (p, m) => sent.push(m), sendYou: () => {} }; let t = 100;
  const v = new Venues(game, { rnd: opts.rnd || lcg(9), now: () => t });
  const p = { id: 'c1', money: opts.money ?? 1000, ship: { cls: opts.cls || 'cruise362' }, stats: {}, cond: 100 };
  const act = (m) => { t += 1; sent.length = 0; v.onAction(p, { action: 'venue', ...m }); return sent[sent.length - 1]; };
  return { game, v, p, act, sent, tick: (s) => { t += s; } };
}
test('server venues: prices are charged on the server, the captain is seen, nothing else is believed', () => {
  const W = world();
  let r = W.act({ kind: 'bar', option: 'cocktail', cost: 0, price: -5 }); assert.equal(r.ok, true); assert.equal(r.cost, 11); assert.equal(W.p.money, 989); assert.equal(W.p.guest.visits.bar, 7200); assert.ok(r.guest.stars > 0);
  assert.equal(W.act({ kind: 'bar', option: 'free_beer' }).ok, false); assert.equal(W.p.money, 989);
  assert.equal(W.act({ kind: 'surf', option: 'surf' }).ok, false, 'the 362 has no surf simulator');
  assert.equal(W.act({ kind: 'roulette', option: 'x' }).ok, false, 'tables go through the casino action');
  W.p.money = 10; r = W.act({ kind: 'spa', option: 'massage' }); assert.equal(r.ok, false); assert.match(r.text, /95 cr/); assert.equal(W.p.money, 10);
  assert.equal(W.act({ kind: 'bar', option: 'coffee' }).ok, true); assert.equal(W.act({ kind: 'bar', option: 'coffee' }).ok, false, 'one moment please: the same venue twice in a row'); W.tick(10); assert.equal(W.act({ kind: 'bar', option: 'coffee' }).ok, true);
  assert.equal(W.p.stats.onboard.spent, 11 + 3 + 3);
  const R = world({ cls: 'rivercruise110' }); assert.equal(R.act({ kind: 'show', option: 'revue' }).ok, false); assert.equal(R.act({ kind: 'bar', option: 'beer' }).ok, true);
  const S = world({ cls: 'ulcv24k' }); assert.equal(S.act({ kind: 'bar', option: 'beer' }).ok, false);
  r = W.act({ kind: 'show', option: 'revue' }); W.p.money = 500; W.tick(10); r = W.act({ kind: 'show', option: 'revue' }); assert.ok(r.audience >= 3 && r.audience <= 5);
  r = W.act({ kind: 'arcade', option: 'play', score: 9999 }); assert.equal(r.score, 100);
});
test('server venues: the art auction returns 87 % on average and never pays negative', () => {
  const rnd = lcg(4); let tot = 0, N = 200000; for (let i = 0; i < N; i++) { const v = auctionValue(300, rnd); assert.ok(v >= 0); tot += v; }
  assert.ok(Math.abs(tot / N / 300 - 0.87) < 0.02, `${tot / N / 300}`);
  const W = world({ money: 400 }); const r = W.act({ kind: 'art', option: 'auction' }); assert.equal(r.ok, true); assert.ok(W.p.money >= 100 && Number.isInteger(W.p.money));
});
