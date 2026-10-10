// World economy, Lane B: Anno-style requests, pledges, the reserve and the general traders (docs/WORLD-ECONOMY-CONTRACT.md
// §6.8, §6.9, §7, §11 X2/X4/X5/X10, §17 econ-requests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { ECON2, ECON2X, requestTerms } from '../shared/econ/model.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const T0 = Date.UTC(2026, 8, 1) / 1000;
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-econ-req.json' }); g.saveState = () => {}; g.rnd = () => 0.5; g.simTime = T0; for (const h of HARBORS) g.harbors[h.id].ev = null; return g; }
function join(g, name) { const ws = fakeSocket(); const p = g.connect(ws, null, name); return { p, ws }; }
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
/** A coffee request at Rotterdam (stock at 30 % of normal). */
function coffeeRequest(g) {
  const st = g.harbors.rotterdam; st.req = [];
  st.stock.coffee = Math.round(st.target.coffee * 0.3);
  g.econ.step(1 / 60, g.simTime);
  return st.req.find((q) => q.good === 'coffee');
}
/** Customs on a sale (politics §4.9): "(duty X cr, fee Y cr)" in the last event. */
const customs = (ws) => { const t = events(ws).filter((x) => /Delivered|Sold/.test(x)).at(-1) || ''; const n = (re) => Number(re.exec(t)?.[1]?.replace(/,/g, '') || 0); return n(/duty ([\d,]+) cr/) + n(/fee ([\d,]+) cr/); };
const stack = (good, qty, extra = {}) => ({ good, qty, contraband: false, jobId: null, origin: 'BR', src: 'santos', srcRole: 'P', unit: 'teu', units: qty / 12, ...extra });

test('a harbour posts a request below s/n 0.6 only, at most REQ_MAX, terms from requestTerms', () => {
  const g = mkGame(), st = g.harbors.rotterdam, e = g.econ;
  st.req = [];
  for (const k of [...e.rowMap[e.hIdx.get('rotterdam')].values()]) st.stock[e.gOf(k)] = e.n(k) * 1.0;   // everything at normal: no request
  g.econ.step(1 / 60, g.simTime);
  assert.equal(st.req.length, 0);
  const q = coffeeRequest(g);
  assert.ok(q, 'coffee request posted');
  const n = st.target.coffee, km = e.nearestMakerKm('rotterdam', 'coffee');
  const t = requestTerms({ r: q.r0, price: st.market.coffee, seaKm: km, size: 'mega', n, s: st.stock.coffee, good: 'coffee' });
  assert.equal(q.premium, t.premium); assert.equal(q.qty % 12, 0); assert.ok(q.qty <= ECON2X.REQ_QMAX.mega);
  assert.ok(q.premium >= 0.15 && q.premium <= 0.40);
  assert.equal(q.dueAt - q.postedAt, t.deadlineH * 3600);
  // many short goods: never more than REQ_MAX (mega 6)
  for (const k of e.rowMap[e.hIdx.get('rotterdam')].values()) if (e.role[k] === 3) st.stock[e.gOf(k)] = e.n(k) * 0.1;
  g.econ.step(1 / 60, g.simTime);
  assert.equal(st.req.length, ECON2X.REQ_MAX.mega);
  assert.equal(new Set(st.req.map((x) => x.good)).size, st.req.length, 'one per good');
  // a minor harbour holds one at most
  const mi = HARBORS.find((h) => h.size === 'minor'); const sm = g.harbors[mi.id];
  for (const k of e.rowMap[e.hIdx.get(mi.id)].values()) if (e.role[k] === 3) sm.stock[e.gOf(k)] = 0;
  g.econ.step(1 / 60, g.simTime);
  assert.ok(sm.req.length <= 1);
});

test('delivering pays the locked price, lowers the market price, pledges reserve, the bonus is paid pro rata on completion', () => {
  const g = mkGame(), st = g.harbors.rotterdam;
  const a = join(g, 'Ana'), b = join(g, 'Ben');
  const q = coffeeRequest(g);
  const unit = q.unit, total = q.qty;
  // A pledges a third; B can then deliver only what is not pledged
  const third = Math.floor(total / 3 / 12) * 12;
  g.onAction(a.p, { action: 'pledge_request', reqId: q.id, qty: third });
  assert.match(events(a.ws).at(-1), /Pledged/);
  assert.equal(q.pledges.length, 1);
  b.p.cargo = [stack('coffee', total)]; b.p.money = 0; b.p.ship.cls = 'boxship';
  const price0 = st.market.coffee, m0 = b.p.money, s0 = st.stock.coffee, f0 = g.econ.priceFor(harborById('rotterdam'), 'coffee', s0) ;
  g.onAction(b.p, { action: 'deliver_request', reqId: q.id });
  const doneB = total - third;
  assert.equal(q.done, doneB, 'B fills only the unpledged part');
  assert.equal(st.stock.coffee, s0 + doneB, 'the tonnes go into the harbour stock');
  assert.ok(st.market.coffee <= price0 && g.econ.priceFor(harborById('rotterdam'), 'coffee', st.stock.coffee) <= f0, 'delivery lowers (or, at the landed ceiling, holds) the price');
  assert.equal(b.p.money - m0, Math.round(unit * doneB) - customs(b.ws), 'paid at the locked price (less customs)');
  assert.equal(q.unit, unit);
  // a second pledge by the same player replaces the first; pledges never exceed what remains
  g.onAction(a.p, { action: 'pledge_request', reqId: q.id, qty: total * 10 });
  assert.equal(q.pledges.filter((x) => x.pid === a.p.id).length, 1);
  assert.ok(q.pledges[0].qty <= total - q.done);
  // A completes it: paid for the tonnes plus 5 % of the request value split pro rata (B gets her share too)
  a.p.cargo = [stack('coffee', third)]; a.p.money = 0; a.p.ship.cls = 'boxship';
  const mb = b.p.money;
  g.onAction(a.p, { action: 'deliver_request', reqId: q.id });
  assert.ok(!st.req.some((x) => x.id === q.id), 'request closed');
  const bonus = ECON2.REQ_BONUS * total * unit;
  assert.equal(a.p.money, Math.round(unit * third) - customs(a.ws) + Math.round(bonus * third / total));
  assert.equal(b.p.money - mb, Math.round(bonus * doneB / total));
  assert.match(events(b.ws).at(-1), /bonus/);
});

test('eligibility: stacks bought at an importer, contract cargo and old stacks cannot fill a request; caught fish can', () => {
  const g = mkGame();
  const { p, ws } = join(g, 'Cid'); p.ship.cls = 'boxship';
  const q = coffeeRequest(g);
  p.cargo = [stack('coffee', 120, { src: 'hamburg', srcRole: 'I' })];
  g.onAction(p, { action: 'deliver_request', reqId: q.id });
  assert.equal(q.done, 0); assert.match(events(ws).at(-1), /bought at Hamburg, which imports it/);
  p.cargo = [stack('coffee', 120, { jobId: 'j1', src: undefined, srcRole: undefined })];
  g.onAction(p, { action: 'deliver_request', reqId: q.id });
  assert.equal(q.done, 0); assert.match(events(ws).at(-1), /Contract cargo cannot fill a request/);
  p.cargo = [{ good: 'coffee', qty: 120, contraband: false, jobId: null }];   // an old stack: no src
  g.onAction(p, { action: 'deliver_request', reqId: q.id });
  assert.equal(q.done, 0); assert.match(events(ws).at(-1), /no known source/);
  assert.ok(g.econ.stackSrcOk({ good: 'fish', qty: 5, caught: true, jobId: null }));
  // docked elsewhere: refused
  p.cargo = [stack('coffee', 120)]; p.docked = 'hamburg';
  g.onAction(p, { action: 'deliver_request', reqId: q.id }); assert.match(events(ws).at(-1), /Dock at Rotterdam/);
});

test('the reserve: an importer below normal sells nothing; above normal it sells only the surplus (X2)', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Dee'); p.ship.cls = 'boxship'; p.money = 1e8;
  const st = g.harbors.rotterdam, n = st.target.coffee;
  st.stock.coffee = n * 0.9;
  g.onAction(p, { action: 'buy_goods', good: 'coffee', qty: 100 });
  assert.equal(p.cargo.length, 0); assert.match(events(ws).at(-1), /does not sell green coffee — it imports it\. Green coffee is made in/);
  st.stock.coffee = n + 50;
  g.onAction(p, { action: 'buy_goods', good: 'coffee', qty: 500 });
  assert.equal(p.cargo.reduce((s, c) => s + c.qty, 0), 50);
  assert.equal(p.cargo[0].srcRole, 'I');   // and it can never fill a request
  // a maker keeps 0.2 n
  const ss = g.harbors.santos, ns = ss.target.coffee; ss.stock.coffee = 0.2 * ns + 30; p.docked = 'santos'; p.cargo = [];
  g.onAction(p, { action: 'buy_goods', good: 'coffee', qty: 500 });
  assert.equal(p.cargo.reduce((s, c) => s + c.qty, 0), 30);
});

test('general traders buy unlisted goods at 45 % of base, 500 t a day shared, without touching stock (§6.9, X3)', () => {
  const g = mkGame();
  const h = HARBORS.find((x) => g.econ.row(x.id, 'coffee') < 0 && x.size !== 'minor');
  assert.ok(h, 'a harbour that does not trade coffee');
  const a = join(g, 'Eve'), b = join(g, 'Fin');
  for (const x of [a, b]) { x.p.docked = h.id; x.p.ship.cls = 'boxship'; x.p.cargo = [stack('coffee', 400)]; x.p.money = 0; }
  const fee = (x) => Number(/fee ([\d,]+) cr/.exec(events(x.ws).at(-1))?.[1]?.replace(/,/g, '') || 0) + Number(/duty ([\d,]+) cr/.exec(events(x.ws).at(-1))?.[1]?.replace(/,/g, '') || 0);   // customs (politics §4.9)
  g.onAction(a.p, { action: 'sell_goods', good: 'coffee', qty: 400 });
  assert.match(events(a.ws).at(-1), /general traders at 1,055 cr\/t/); assert.equal(a.p.money, 1055 * 400 - fee(a));
  g.onAction(b.p, { action: 'sell_goods', good: 'coffee', qty: 400 });
  assert.equal(b.p.money, 1055 * 100 - fee(b), 'the cap is shared: 100 t left today');
  g.onAction(b.p, { action: 'sell_goods', good: 'coffee', qty: 300 });
  assert.match(events(b.ws).at(-1), /bought their 500 t/);
  assert.ok(!('coffee' in g.harbors[h.id].stock));
  g.simTime += 86400; const mb = b.p.money;
  g.onAction(b.p, { action: 'sell_goods', good: 'coffee', qty: 300 });
  assert.equal(b.p.money - mb, 1055 * 300 - fee(b), 'a new day, a new cap');
});

test('pledge lapses: a lapsed pledge costs nothing; three lapses in 7 days block pledging for 24 h (X5)', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Gus');
  const q = coffeeRequest(g);
  for (let i = 0; i < 3; i++) {
    g.onAction(p, { action: 'pledge_request', reqId: q.id, qty: 120 });
    const until = q.pledges.find((x) => x.pid === p.id).until;
    g.simTime = until + 1; g.econ.step(1 / 60, g.simTime);
    assert.ok(!q.pledges.some((x) => x.pid === p.id), 'lapsed');
  }
  g.onAction(p, { action: 'pledge_request', reqId: q.id, qty: 120 });
  assert.match(events(ws).at(-1), /Three pledges lapsed this week/);
  g.simTime += 86401;
  g.onAction(p, { action: 'pledge_request', reqId: q.id, qty: 120 });
  assert.match(events(ws).at(-1), /Pledged/);
  g.onAction(p, { action: 'unpledge_request', reqId: q.id });
  assert.match(events(ws).at(-1), /Pledge released/);
});

test('requests close at the deadline and when the market recovers; a closed port freezes deadlines', () => {
  const g = mkGame();
  const q = coffeeRequest(g), st = g.harbors.rotterdam;
  st.ev = { kind: 'closed', from: g.simTime, until: null, text: 'closed' };
  const due = q.dueAt; g.econ.maintainRequests(g.econ.hIdx.get('rotterdam'), st, g.simTime, 5);
  assert.equal(q.dueAt, due + 5 * 3600, 'frozen while closed');
  st.ev = null;
  st.stock.coffee = st.target.coffee;   // recovered, no live pledge
  g.econ.maintainRequests(g.econ.hIdx.get('rotterdam'), st, g.simTime, 0);
  assert.ok(!st.req.includes(q));
  const q2 = coffeeRequest(g);
  g.econ.maintainRequests(g.econ.hIdx.get('rotterdam'), st, q2.dueAt + 1, 0);
  assert.ok(!st.req.includes(q2), 'expired');
});

test('the harbour payload carries make/need, requests and every listed good', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Hal');
  coffeeRequest(g); g.sendHarbor(p);
  const e = ws.sent.filter((m) => m.t === 'harbor').at(-1).harbor.econ;
  assert.ok(e.make.some((x) => x.good === 'flowers') && e.need.some((x) => x.good === 'coffee'));
  assert.ok(e.requests.some((r) => r.good === 'coffee' && r.maker && r.open > 0));
  assert.equal(e.goods.length, g.econ.rowMap[g.econ.hIdx.get('rotterdam')].size);
  const coffee = e.goods.find((x) => x.id === 'coffee');
  assert.equal(coffee.role, 'I'); assert.equal(coffee.buyable, 0); assert.ok(coffee.maker.km > 1000);
  assert.ok(e.stock.coffee >= 0 && e.target.coffee > 0, 'legacy econ fields kept');
});
