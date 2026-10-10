// docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §9 test 5: the yard server (server/yard.js) on a real Game. Phase 1: game.js is
// not wired yet (H2–H4), so the tests attach `new Yard(g)` themselves and call yard.action / yard.tick like the hooks will.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { Yard } from '../server/yard.js';
import { FLEET, dayKey } from '../shared/fleet.js';
import { jonesOk, marketValue, makeListing, MODELS } from '../shared/ships/index.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function fakeSocket() { const s = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; return s; }
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json', ...opts }); g.saveState = () => {}; return g; }
function join(g, name) { const ws = fakeSocket(); const p = g.connect(ws, null, name); return { p, ws }; }
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
/** Set cash the way the fleet ledger expects (outside the ledger, like a job payment the drift booking picks up). */
function cash(g, p, cr) { p.money = cr; g.fleet.m0.set(p.id, cr); }
function setup(money = 1000000) {
  const g = mkGame(); const { p, ws } = join(g, 'Ann'); cash(g, p, money);
  const y = new Yard(g); g.yard = y;
  return { g, p, ws, y };
}
function at(g, y, t) { g.simTime = t; y.tick(t); }
const order = (y, p, extra = {}) => y.action(p, { action: 'yard_order', variant: 'ultramax64', yard: 'yzj', ...extra });

test('E1 order: 606,700 at signing (ledger "ships"), steel cut at 36 h, missed keel instalment → warning → default after 48 h', () => {
  const { g, p, ws, y } = setup();
  const o = order(y, p);
  assert.ok(o && o.id); assert.equal(o.price, 6067000); assert.equal(o.state, 'ordered');
  assert.equal(p.money, 1000000 - 606700);
  assert.equal(p.office.book.days[dayKey(g.simTime)]._.ships, -606700);
  assert.equal(p.office.orders.length, 1);
  assert.equal(o.schedule[0].paidAt, o.createdAt);
  cash(g, p, p.money + 900000);
  at(g, y, o.createdAt + 36 * 3600);
  assert.equal(o.state, 'building'); assert.ok(o.schedule[1].paidAt);
  assert.equal(p.money, 393300 + 900000 - 606700);
  assert.ok(events(ws).some((t) => /Steel cut for HN \d{4} \(Ultramax 64k, geared\) at Yangzijiang Shipbuilding — 606,700 cr paid/.test(t)));
  cash(g, p, 100000);
  at(g, y, o.schedule[2].dueAt);
  assert.ok(o.warnedAt > 0); assert.equal(o.state, 'building');
  assert.ok(events(ws).some((t) => /keel laid instalment of 606,700 cr is due and your cash is short/.test(t)));
  at(g, y, o.schedule[2].dueAt + 47 * 3600);
  assert.equal(o.state, 'building', 'still inside the grace period');
  at(g, y, o.schedule[2].dueAt + 48 * 3600);
  assert.equal(o.state, 'defaulted'); assert.equal(p.money, 100000, 'paid instalments are lost');
});

test('cancel after three paid instalments refunds 2 × 606,700 × 0.8 = 970,720', () => {
  const { g, p, y } = setup(5000000);
  const o = order(y, p);
  at(g, y, o.schedule[2].dueAt);
  assert.equal(o.schedule.filter((s) => s.paidAt).length, 3);
  const m0 = p.money;
  assert.equal(y.action(p, { action: 'yard_cancel', orderId: o.id }), 970720);
  assert.equal(p.money, m0 + 970720); assert.equal(o.state, 'cancelled');
  assert.equal(y.action(p, { action: 'yard_cancel', orderId: o.id }), false);
});

test('delivery creates the vessel at the yard harbour: cls ultramax64, built in CN at yzj, docked at Shanghai, fuel 25 %', () => {
  const { g, p, ws, y } = setup(20000000);
  const o = order(y, p, { name: 'Salt Queen' });
  at(g, y, o.deliverAt);
  assert.equal(o.state, 'delivered');
  const v = p.fleet.find((x) => x.id === o.vesselId);
  assert.ok(v);
  assert.equal(v.ship.cls, 'ultramax64'); assert.equal(v.name, 'Salt Queen'); assert.equal(v.builtIn, 'CN');
  assert.equal(v.hist.yard, 'yzj'); assert.equal(v.hist.builtIn, 'CN'); assert.equal(v.hist.estimated, false); assert.equal(v.hist.hull, o.hull);
  assert.equal(v.docked, 'shanghai'); assert.equal(v.fuel, Math.round(0.25 * 1165 * 10) / 10); assert.equal(v.cond, 100);
  assert.equal(v.spec.model, 'ultramax64'); assert.equal(v.hist.warrantyTo, o.deliverAt + 720 * 3600); assert.equal(v.hist.specialist, true);
  assert.equal(v.acquiredPrice, 6067000);
  const paid = o.schedule.reduce((s, x) => s + (x.cash || 0), 0);
  assert.equal(paid + o.ldCr, 6067000, 'all instalments paid, liquidated damages credited against the delivery instalment');
  assert.equal(p.money, 20000000 - 6067000 + o.ldCr);
  assert.ok(events(ws).some((t) => /^Delivered: Salt Queen \(Ultramax 64k, geared, HN \d{4}\) at Shanghai/.test(t)));
  assert.equal(marketValue(v, 'CN', g.simTime), Math.round(6950000 * 0.55 * 0.95));
});

test('a finished ship waits at the yard when the fleet is full, and storage is charged', () => {
  const { g, p, y } = setup(20000000);
  const o = order(y, p);
  for (let i = p.fleet.length; i < FLEET.MAX_VESSELS; i++) {
    const v = g.fleet.makeVessel(p.id, { name: `Filler ${i}`, ship: { cls: 'pilot', lat: 51.98, lon: 4.03, hdg: 0, spd: 0, throttle: 0, rudder: 0 }, docked: 'rotterdam' });
    p.fleet.push(v); g.fleet.index(v);
  }
  at(g, y, o.deliverAt);
  assert.equal(o.state, 'ready'); assert.equal(o.vesselId, null);
  const m0 = p.money;
  at(g, y, o.deliverAt + 2 * 86400 + 60);
  const fee = Math.max(25, Math.round(0.01 * MODELS.ultramax64.displacement));
  assert.equal(p.money, m0 - 2 * fee); assert.equal(o.storageCr, 2 * fee);
  // room again → delivered on the next tick
  const f = p.fleet.pop(); g.fleet.unindex(f);
  at(g, y, o.deliverAt + 2 * 86400 + 120);
  assert.equal(o.state, 'delivered');
});

test('orders count toward the fleet limit; trade-in credits the first instalment', () => {
  const { g, p, y } = setup(30000000);
  for (let i = 0; i < 4; i++) assert.ok(order(y, p), `order ${i}`);
  assert.equal(order(y, p), false, 'at most YARD.MAX_OPEN_ORDERS open orders');
  const { p: q, y: y2, g: g2 } = setup(1000);
  const v = g2.fleet.makeVessel(q.id, { name: 'Old Tub', ship: { cls: 'feeder', lat: 51.98, lon: 4.03, hdg: 0, spd: 0, throttle: 0, rudder: 0 }, docked: 'rotterdam', cond: 100 });
  q.fleet.push(v); g2.fleet.index(v);
  const credit = marketValue(v, 'NL', g2.simTime);
  const o = y2.action(q, { action: 'yard_order', variant: 'tug24', yard: 'damen_gorinchem', tradeIn: v.id });
  assert.ok(o, 'the trade-in pays the contract instalment');
  assert.equal(o.tradeIn.cr, credit); assert.ok(!q.fleet.includes(v));
  assert.equal(q.money, 1000, 'nothing charged in cash');
  void g;
});

test('inspection of a 2,000,000 listing costs 4,000 and reveals the exact condition after 2 h', () => {
  const { g, p, y } = setup(100000);
  g.simTime = Math.floor(g.simTime / 21600) * 21600 + 60;   // start of a 6 h listing window
  const h = harborById('rotterdam');
  const list = y.listingsAt(h);
  assert.equal(list.length, 8, 'mega harbour: 8 listings');
  const l = { ...makeListing(h, 0, 0, null, { simTime: g.simTime }), id: 'utest', price: 2000000, cond: 61, condLo: 55, condHi: 75 };
  list.push(l);
  const pub = () => y.view(p, h).used.find((x) => x.id === 'utest');
  assert.equal(pub().cond, undefined); assert.equal(pub().condExact, null); assert.equal(pub().defect, undefined);
  assert.equal(y.action(p, { action: 'yard_inspect', listingId: 'utest' }), 4000);
  assert.equal(p.money, 96000);
  at(g, y, g.simTime + 3600);
  assert.equal(pub().condExact, null);
  at(g, y, g.simTime + 3600);
  assert.equal(pub().condExact, 61); assert.equal(pub().report.cond, 61);
  assert.ok(pub().hist.flags.length >= 1 && pub().hist.class && pub().hist.yard);
});

test('buying a second-hand listing: history and build country carried over', () => {
  const { g, p, y } = setup(50000000);
  const h = harborById('rotterdam'), l = y.listingsAt(h)[0];
  const v = y.action(p, { action: 'yard_buy_used', listingId: l.id });
  assert.ok(v); assert.equal(v.ship.cls, l.cls); assert.equal(v.cond, l.cond); assert.equal(v.builtIn, l.hist.builtIn);
  assert.equal(v.hist.owners, l.hist.owners + 1); assert.equal(v.built, l.hist.built);
  assert.equal(p.money, 50000000 - l.price);
  assert.ok(!y.listingsAt(h).includes(l));
});

test('stock hull bought at once; repaint and rename', () => {
  const { g, p, y } = setup(5000000);
  const s = y.view(p, harborById('rotterdam')).stock;
  assert.ok(s.length >= 1);
  const v = y.action(p, { action: 'yard_buy_stock', stockId: s[0].id, name: 'Quick One' });
  assert.ok(v); assert.equal(v.name, 'Quick One'); assert.equal(p.money, 5000000 - s[0].price);
  assert.equal(y.view(p, harborById('rotterdam')).stock.find((x) => x.id === s[0].id), undefined, 'sold');
  const livery = { hull: 0x112233, boot: 0x8b1a1a, house: 0xffffff, funnel: 0x000000, band: null, mark: 'AB', nameColor: 0xffffff };
  assert.ok(y.action(p, { action: 'yard_repaint', vesselId: v.id, livery }));
  assert.deepEqual(v.spec.livery, livery);
  assert.equal(y.action(p, { action: 'yard_repaint', vesselId: v.id, livery: { hull: 'red' } }), false);
  assert.ok(y.action(p, { action: 'yard_rename', vesselId: v.id, name: 'Second Wind' }));
  assert.equal(v.name, 'Second Wind');
  void g;
});

test('a US company\'s tug24 from Eastern Shipbuilding is Jones-eligible; a re-flag abroad loses it for ever', () => {
  const { g, p, ws, y } = setup(2000000);
  p.office.home = 'new_york';
  const o = y.action(p, { action: 'yard_order', variant: 'tug24', yard: 'eastern_sb' });
  assert.equal(o.price, 497000);
  at(g, y, o.deliverAt);
  const v = p.fleet.find((x) => x.id === o.vesselId);
  assert.equal(v.docked, 'tampa'); assert.equal(v.builtIn, 'US');
  assert.equal(jonesOk(v), true);
  assert.equal(marketValue(v, 'US', g.simTime), Math.round(256000 * 0.55 * 1.6));
  y.onReflag(p, v, 'US', 'PA');
  assert.ok(events(ws).some((t) => /never again trade between US ports/.test(t)));
  y.onReflag(p, v, 'PA', 'US');
  assert.equal(v.hist.jonesLost, true); assert.equal(jonesOk(v), false);
});

test('validation: unknown design, yard that cannot build it, option the yard lacks, local yard elsewhere', () => {
  const { p, ws, y } = setup(5000000);
  assert.equal(y.action(p, { action: 'yard_order', variant: 'nosuch', yard: 'yzj' }), false);
  assert.equal(y.action(p, { action: 'yard_order', variant: 'vlcc300', yard: 'yzj' }), false);
  assert.equal(y.action(p, { action: 'yard_order', variant: 'ultramax64~meoh', yard: 'tsuneishi_cebu' }), false);
  assert.ok(events(ws).includes('This yard does not build methanol engines.'));
  assert.equal(y.action(p, { action: 'yard_order', variant: 'rib8', yard: 'local:hamburg' }), false);
  assert.ok(y.action(p, { action: 'yard_order', variant: 'rib8', yard: 'local:rotterdam' }));
  assert.equal(y.action(p, { action: 'yard_pay', orderId: 'ozzz' }), false);
  assert.equal(y.action(p, { action: 'nope' }), false);
});

test('rush delivery (speed-up): pays the unpaid instalments + a 8–20 % fee and delivers at once; refused when short of cash or fleet full', () => {
  const { g, p, ws, y } = setup(1000000);
  const o = order(y, p);                                   // 6,067,000 hull: contract instalment only
  const q = y.rushQuote(p, o);
  assert.equal(q.premium, Math.round(6067000 * 0.20), 'fresh order: 20 % fee');
  assert.equal(q.cash, 6067000 - 606700, 'the instalments still unpaid');
  assert.equal(y.action(p, { action: 'yard_rush', orderId: o.id }), false, 'not enough cash');
  assert.ok(events(ws).at(-1).includes('rush delivery costs'));
  assert.equal(o.state, 'ordered');
  cash(g, p, 20000000); const m0 = p.money;
  assert.equal(y.action(p, { action: 'yard_rush', orderId: o.id }), q.total);
  assert.equal(o.state, 'delivered'); assert.ok(o.vesselId);
  assert.equal(p.money, m0 - q.total);
  assert.ok(p.fleet.some((v) => v.id === o.vesselId));
  assert.ok(events(ws).some((t) => /rush delivery/.test(t)));
  assert.equal(y.action(p, { action: 'yard_rush', orderId: o.id }), false, 'already delivered');
  // later in the build the fee shrinks towards 8 %
  const o2 = order(y, p);
  at(g, y, o2.launchAt);
  const q2 = y.rushQuote(p, o2);
  assert.ok(q2.premium < q.premium && q2.premium >= Math.round(6067000 * 0.08), `${q2.premium}`);
  // fleet full: refused before charging
  const o3 = order(y, p); cash(g, p, 30000000); const m1 = p.money;
  for (let i = p.fleet.length; i < FLEET.MAX_VESSELS; i++) {
    const v = g.fleet.makeVessel(p.id, { name: `Filler ${i}`, ship: { cls: 'pilot', lat: 51.98, lon: 4.03, hdg: 0, spd: 0, throttle: 0, rudder: 0 }, docked: 'rotterdam' });
    p.fleet.push(v); g.fleet.index(v);
  }
  assert.equal(y.action(p, { action: 'yard_rush', orderId: o3.id }), false);
  assert.equal(p.money, m1);
});

test('order with rush: ordered and delivered in one go; with too little cash nothing is ordered', () => {
  const { g, p, y } = setup(1000000);
  assert.equal(order(y, p, { rush: true }), false, 'cash short');
  assert.equal(p.office.orders.length, 0); assert.equal(p.money, 1000000);
  cash(g, p, 9000000);
  const o = order(y, p, { rush: true });
  assert.equal(o.state, 'delivered');
  assert.equal(p.money, 9000000 - Math.round(6067000 * 1.20));
});
