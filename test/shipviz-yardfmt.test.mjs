// Shipyard screen — pure formatting and selection logic (public/js/yardfmt.js): docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md
// §9 test 8 — price/time strings, instalment table rows (E1), reasons, compare rows pick best values, filter logic
// (the Jones-eligible filter keeps only US yards), option groups and variants, orders and listings.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../public/js/yardfmt.js';
import { MODELS, YARDS, makeListing, publicListing, inspectionReport, newOrder, compactOrder, registerHarbors, defaultLivery } from '../shared/ships/index.js';

test('price and time strings', () => {
  assert.equal(F.fmtCr(6067000), '6.07 M cr');
  assert.equal(F.fmtCr(12400000), '12.4 M cr');
  assert.equal(F.fmtCr(38500000), '38.5 M cr');
  assert.equal(F.fmtCr(497000), '497,000 cr');
  assert.equal(F.fmtCr(-2500), '−2,500 cr');
  assert.equal(F.fmtHours(95.4), '95 h (4 d)');
  assert.equal(F.fmtHours(138), '138 h (6 d)');
  assert.equal(F.fmtHours(18.2), '18 h');
  assert.equal(F.fmtHours(0.5), '30 min');
  assert.equal(F.fmtDue(1000 + 12 * 3600, 1000), 'in 12 h');
  assert.equal(F.fmtDue(1000, 1000 + 5 * 3600), 'overdue 5 h');
  assert.equal(F.flagOf('KR'), '🇰🇷'); assert.equal(F.flagOf('XX'), '🏳️'); assert.equal(F.countryName('US'), 'United States');
});

test('instalment table rows: E1 Ultramax at Yangzijiang (tail schedule)', () => {
  const rows = F.instalmentRows(6067000, 'yzj', 'ultramax64', 0, 'ultramax64');
  assert.deepEqual(rows.map((r) => r.cr), [606700, 606700, 606700, 606700, 3640200]);
  assert.deepEqual(rows.map((r) => r.pct), [10, 10, 10, 10, 60]);
  assert.deepEqual(rows.map((r) => r.label), ['Contract', 'Steel cutting', 'Keel laying', 'Launch', 'Delivery']);
  assert.deepEqual(rows.map((r) => r.at), [0, 36 * 3600, 50.85 * 3600, 74.61 * 3600, 95.4 * 3600].map((x) => Math.round(x)));
  assert.equal(rows[4].crText, '3.64 M cr');
  const sum = F.orderSummary('ultramax64', 'yzj', { tradeIn: 100000 });
  assert.equal(sum.price, 6067000); assert.equal(sum.dueNow, 506700); assert.equal(sum.hoursText, '95 h (4 d)');
  // US yard: E3 MR tanker at Philly, × 2.0
  assert.equal(F.orderSummary('mr50', 'philly').price, 12400000);
  assert.equal(F.orderSummary('mr50', 'philly').hours, 138);
  // a small boat pays 30 / 70
  assert.deepEqual(F.instalmentRows(497000, 'eastern_sb', 'tug24').map((r) => r.pct), [30, 70]);
});

test('filter logic: Jones-eligible keeps only US yards; type, price, afford, sort', () => {
  const all = F.filterDesigns({ type: 'tanker' });
  const jones = F.filterDesigns({ type: 'tanker', jones: true });
  assert.ok(jones.length > 0 && jones.length < all.length);
  for (const c of jones) assert.equal(YARDS[c.fromYard].cc, 'US', `${c.id} from ${c.fromYard}`);
  assert.ok(!jones.some((c) => c.id === 'vlcc300'), 'no US yard builds a VLCC');
  for (const r of F.yardRows('mr50', { jones: true })) assert.equal(r.cc, 'US');
  assert.ok(F.yardRows('mr50').some((r) => r.cc !== 'US'));
  // price cap and the first-instalment check
  for (const c of F.filterDesigns({ maxPrice: 500000 })) assert.ok(c.from <= 500000);
  const afford = F.filterDesigns({ afford: true }, { money: 100000 });
  assert.ok(afford.length > 0 && afford.every((c) => c.afford));
  const byPrice = F.filterDesigns({ type: 'bulk', sort: 'price' });
  for (let i = 1; i < byPrice.length; i++) assert.ok(byPrice[i].from >= byPrice[i - 1].from);
  assert.equal(F.filterDesigns({ q: 'ultramax' })[0].id, 'ultramax64');
  // the cheapest yard for an Ultramax (CN tail schedule, bulk specialist)
  const c = F.designCard('ultramax64');
  assert.equal(c.from, 6067000); assert.equal(YARDS[c.fromYard].cc, 'CN');
  assert.ok(c.badges.some((b) => b.id === 'geared'));
});

test('reasons: blocked yards (politics R3) and options a yard cannot build', () => {
  const check = (cc) => (cc === 'RU' ? { ok: false, block: { text: 'Not allowed for your company: measures against RU' } } : { ok: true });
  const rows = F.yardRows('vlcc300', { yardCheck: check });
  const ru = rows.find((r) => r.cc === 'RU');
  assert.ok(ru && ru.blockText === 'Not allowed for your company: measures against RU');
  assert.ok(F.politicsBadges({ cc: 'RU', blockText: ru.blockText }).some((b) => b.id === 'blocked'));
  assert.ok(F.politicsBadges({ cc: 'US' }).some((b) => b.id === 'jones'));
  const card = F.designCard('vlcc300', { yardCheck: check });
  assert.equal(card.blocked, 1);
  // methanol at Imabari: the yard does not build it → dropped with the reason, variant falls back
  const v = F.variantFor('ultramax64', { engine: 'meoh', esd: true }, 'imabari');
  assert.equal(v.variant, 'ultramax64~esd');
  assert.equal(v.dropped[0].why, 'This yard does not build methanol engines.');
  assert.equal(F.variantFor('ultramax64', { engine: 'lng', ice: 'i1c', esd: true }, 'imabari').variant, 'ultramax64~lng.i1c.esd');
  // option groups: battery hybrid is not for bulk carriers (model rule), with the reason
  const g = F.optionGroups('ultramax64', { engine: 'lng' }, null);
  const hyb = g.find((x) => x.group === 'engine').items.find((i) => i.token === 'hyb');
  assert.equal(hyb.ok, false); assert.ok(hyb.why.length > 5);
  assert.equal(g.find((x) => x.group === 'engine').items.find((i) => i.token === 'lng').on, true);
  assert.ok(!F.optionGroups('tug24', {}, null).some((x) => x.group === 'gear'), 'no cargo-gear group on a tug');
});

test('compare rows pick the best value per row (max 4 items)', () => {
  const items = [
    { title: 'A', variant: 'ultramax64', price: 6067000, hours: 95.4 },
    { title: 'B', variant: 'kamsarmax82', price: 7490000, hours: 101 },
    { title: 'C', variant: 'handy38', price: 3890000, hours: 90 },
    { title: 'D', variant: 'ultramax64~lng.esd', price: 7080000, hours: 95.4, cond: 100 },
    { title: 'E', variant: 'vloc400', price: 1, hours: 1 },
  ];
  const t = F.compareRows(items);
  assert.equal(t.cols.length, 4, 'max 4');
  const row = (l) => t.rows.find((r) => r.label === l);
  assert.equal(row('Price').best, 2);
  assert.equal(row('Delivery').best, 2);
  assert.equal(row('Payload').best, 1);
  assert.equal(row('Fuel use').best, 2);
  assert.equal(row('Length').best, -1, 'no rule for length');
  assert.equal(row('Condition').best, -1, 'a tie has no winner');
  assert.equal(row('Price').values[0], '6.07 M cr');
});

test('orders and second-hand listings', () => {
  const now = 1791000000;
  const o = newOrder({ id: 'oabc1', ownerId: 'p', variant: 'ultramax64', yard: 'yzj', createdAt: now - 50 * 3600, openOrders: 0, delayFrac: 0, hull: 'HN 1234' });
  for (const s of o.schedule) if (s.dueAt <= now) s.paidAt = s.dueAt;
  o.state = 'building';
  for (const view of [F.orderView(o, now), F.orderView({ ...compactOrder(o, now), price: o.price, schedule: o.schedule }, now)]) {
    assert.ok(view.progress > 0.2 && view.progress < 0.3, `progress ${view.progress}`);
    assert.equal(view.next.key, 'keel'); assert.equal(view.next.crText, '606,700 cr');
    assert.deepEqual(view.ticks.map((t) => t.at), [0, 0.25, 0.65, 1]);
    assert.equal(view.ticks[0].paid, true); assert.equal(view.ticks[1].paid, false);
    assert.equal(view.stateText, 'Under construction'); assert.equal(view.open, true);
  }
  registerHarbors([{ id: 'new_york', name: 'New York', country: 'US', size: 'mega' }]);
  const l = makeListing('new_york', 0, 77, null, { simTime: now });
  const pub = publicListing(l), card = F.listingCard(pub, now);
  assert.equal(card.inspected, false); assert.equal(card.condText, `${l.condLo}–${l.condHi} %`);
  assert.equal(card.fee, Math.max(500, Math.round(0.002 * l.price)));
  const insp = F.listingCard(publicListing(l, inspectionReport(l, now)), now);
  assert.equal(insp.inspected, true); assert.equal(insp.condText, `${l.cond} %`);
  const h = F.listingHistory(pub);
  assert.equal(h[0].kind, 'built');
  for (let i = 1; i < h.length; i++) assert.ok(h[i].year >= h[i - 1].year);
});

test('livery presets, spec sheet, size lines', () => {
  const l = F.liveryFrom('blue', 'SL');
  assert.equal(l.mark, 'SL'); assert.equal(l.hull, 0x1f4f8c); assert.equal(l.nameColor, 0xffffff);
  assert.equal(F.liveryFrom('white', 'toolong').mark, null);
  assert.equal(F.hex6(0x00ff00), '#00ff00'); assert.equal(F.parseHex('#0A0b0C'), 0x0a0b0c); assert.equal(F.parseHex('nope'), null);
  const sheet = F.specSheet('ultramax64~lng', 'imabari');
  assert.deepEqual(sheet.map((s) => s.title), ['Real-world reference', 'In the game', 'What she carries', 'Where she fits', 'Built at']);
  assert.ok(sheet[0].rows.some(([k, v]) => k === 'Main engine' && v.includes('8,600 kW')));
  assert.ok(sheet[4].rows.some(([k, v]) => k === 'Specialist' && v.startsWith('yes')));
  assert.ok(F.sizeLine(MODELS.ulcv24k).startsWith('24,000 TEU'));
  assert.equal(F.sizeLine(MODELS.tug24), 'bollard pull 70 t');
  assert.equal(F.sizeLine(MODELS.ultramax64), '64,000 DWT · 5 holds');
  assert.ok(F.badgesOf(MODELS.tug24).some((b) => b.id === 'jones'));
  void defaultLivery;
});
