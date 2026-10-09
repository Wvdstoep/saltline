// SHIPYARD phase-2 integration (docs/SHIPS-LANEA/B/C-PHASE2.md): the hooks wired into the game, the exterior built from
// Lane C's real general arrangement (public/js/gaext.js → shipgen.js), the GA deck plans behind GA_READY, the ASD tug's
// hull draught, route planning for catalogue ids, and the cruise service core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODEL_IDS, GA_READY, gaReady } from '../shared/ships/index.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { generalArrangement, outlineHalf } from '../shared/ships/ga.js';
import { exteriorGA } from '../public/js/gaext.js';
import { buildFromGA, shipBounds } from '../public/js/shipgen.js';
import { hullForm, triBudget, DRAW_CALLS } from '../public/js/shipgeom.js';
import { buildPlan, gaPlanned } from '../public/js/shipplan.js';
import { planFromGA } from '../public/js/gaplan.js';
import { parseRouteQuery } from '../server/searoute.js';
import { shipSpecs, shipValue } from '../server/economy.js';
import { vesselSlotsUsed } from '../shared/fleet.js';

const MOTOR = MODEL_IDS.filter((id) => MODELS[id].gen !== 'sail');

test('GA_READY: all 13 generators; the 17 legacy ids keep today\'s models and plans, catalogue models and variants use the GA', () => {
  assert.equal(GA_READY.size, 13);
  for (const id of ['coaster', 'bulker', 'tanker', 'tug', 'ferry', 'superyacht', 'sloop', 'schooner']) assert.equal(gaReady(id), false, id);
  for (const id of ['ultramax64', 'mr50', 'ropax200', 'tug24', 'cruise330', 'ultramax64~lng.esd']) assert.equal(gaReady(id), true, id);
  assert.equal(gaReady('nonsense'), false);
  assert.equal(gaPlanned('ultramax64'), true);
  const ga = buildPlan('ultramax64', SHIP_CLASSES.ultramax64);
  assert.ok(ga.goto?.length && ga.zones?.length, 'GA plan with Go-to and zones');
  const legacy = buildPlan('bulker', SHIP_CLASSES.bulker);
  assert.ok(!legacy.zones, 'the legacy bulker keeps its plan');
});

test('every motor model: exterior from ga.js at scale, inside the budgets, deck edge = the walkable plan\'s deck edge', () => {
  for (const id of MOTOR) {
    const ga = exteriorGA(id), real = generalArrangement(id);
    assert.equal(ga.deckY, real.deckY, `${id} deck height`); assert.equal(ga.hull.draftHull, real.Tk, `${id} hull-body draught`);
    const r = buildFromGA(ga), b = shipBounds(r.lods[0]);
    assert.ok(Math.abs(b.max.z - b.min.z - ga.L) / ga.L <= 0.012, `${id} length ${(b.max.z - b.min.z).toFixed(2)} vs ${ga.L}`);
    assert.ok(b.min.y <= -real.Tk + 0.1 && b.min.y >= -ga.T - 0.1, `${id} keel ${b.min.y.toFixed(2)} between −Tk ${real.Tk} and −T ${ga.T}`);
    assert.ok(r.info.drawCalls[0] <= DRAW_CALLS.desktop && r.info.tris[0] <= triBudget(ga.gen, ga.L), `${id} desktop budget ${r.info.drawCalls[0]} / ${r.info.tris[0]}`);
    const p = buildFromGA(ga, { phone: true, lod: 0 });
    assert.ok(p.info.drawCalls[0] <= DRAW_CALLS.phone && p.info.tris[0] <= triBudget(ga.gen, ga.L, true), `${id} phone budget`);
    const hf = hullForm(ga);
    if (hf.twin) continue;
    for (const [x, z] of outlineHalf(real, 72)) {
      if (Math.abs(z) > ga.L / 2 - Math.max(0.3, ga.L * 0.004)) continue;   // the stem / transom tip itself
      const e = hf.halfBreadth(z, hf.deckAt(z));
      assert.ok(Math.abs(x - e) <= 0.3, `${id} deck edge at z ${z}: plan ${x} vs plating ${e.toFixed(2)}`);
    }
  }
});

test('ASD tugs: the hull-draught column floats the hull (deck 1.1 m above the water, drives to the navigational draught)', () => {
  for (const id of ['tug24', 'tug']) {
    const m = MODELS[id], ga = generalArrangement(id);
    assert.ok(m.draftHull > 0 && m.draftHull < m.draft && m.draftHull < m.depth, `${id} draftHull ${m.draftHull}`);
    assert.equal(ga.Tk, m.draftHull); assert.equal(ga.D, m.depth); assert.ok(Math.abs(ga.deckY - (m.depth - m.draftHull)) < 0.01);
    assert.equal(ga.T, m.draft, 'T stays the navigational draught (routing, grounding)');
    const b = shipBounds(buildFromGA(exteriorGA(id), { lod: 0 }).group);
    assert.ok(Math.abs(b.min.y + m.draft) <= 0.1, `${id} the drives reach −T`);
  }
  assert.equal(shipSpecs('tug24').draftHull, 3.5);
  for (const id of Object.keys(MODELS)) { const m = MODELS[id]; if (m.depth && !m.draftHull && m.gen !== 'sail') assert.ok(m.draft < m.depth || generalArrangement(id).Tk < m.draft, `${id} draught ${m.draft} vs depth ${m.depth}`); }
});

test('route planning accepts catalogue model and variant ids (H1 resolves them) and rejects prototype keys', () => {
  const base = { from: '52.1,3.2', to: '53.5,8.6' };
  assert.equal(parseRouteQuery({ ...base, cls: 'tug24' }).cls, 'tug24');
  assert.equal(parseRouteQuery({ ...base, cls: 'ultramax64~lng.esd' }).ok, true);
  assert.equal(parseRouteQuery({ ...base, cls: 'coaster' }).ok, true);
  for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'nope', 'x'.repeat(80)]) assert.equal(parseRouteQuery({ ...base, cls: bad }).ok, false, bad);
});

test('economy H8b: shipValue unchanged for legacy ids; spec sheet carries the catalogue data', () => {
  assert.equal(shipValue('bulker', 100), Math.round(SHIP_CLASSES.bulker.price * 0.55));
  assert.equal(shipValue('coaster', 78), 0);
  const s = shipSpecs('ultramax64');
  assert.equal(s.model, 'ultramax64'); assert.ok(s.dwt > 60000 && s.kW > 0);
});

test('cruise service core: a walkable crew passage tower to tower, closed stores either side', () => {
  for (const id of ['cruise230', 'cruise330']) {
    const ga = generalArrangement(id);
    for (const d of ga.pax.decks.filter((q) => q.use === 'cabin').slice(0, 2)) {
      const p = planFromGA(id, { deck: d.id });
      const passages = p.rooms.filter((r) => r.use === 'service' && r.walk !== false);
      assert.ok(passages.length > 0, `${id} ${d.id} has service passages`);
      for (const r of passages) {
        assert.ok(r.x1 - r.x0 <= 2.01, `${r.id} is a passage, not a hall`);
        assert.ok(p.doors.some((q) => q.a === r.id || q.b === r.id), `${r.id} has a way in`);
      }
    }
  }
});

// ------------------------------------------------------------------------------------------------ the game hooks
async function realGame() {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const world = new World().load(carvingsForWorld(), () => {});
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-ships-int.json' }); g.saveState = () => {};
  const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
  const p = g.connect(ws, null, 'Ann'); g.tick(0.1);
  const cash = (cr) => { p.money = cr; g.fleet.m0.set(p.id, cr); };
  return { g, p, ws, cash };
}
const lastHarbor = (ws) => [...ws.sent].reverse().find((m) => m.t === 'harbor')?.harbor;
const lastYou = (ws) => [...ws.sent].reverse().find((m) => m.t === 'you')?.you;

test('game H2–H4: harbor.yard, yard actions through onAction, you.orders, the yard ticks with the game', async () => {
  const { g, p, ws, cash } = await realGame();
  assert.ok(g.yard, 'the game owns a Yard');
  g.sendHarbor(p);
  const h = lastHarbor(ws);
  assert.ok(h.yard && Array.isArray(h.yard.stock) && Array.isArray(h.yard.used), 'harbor.yard');
  assert.ok(Array.isArray(h.shipyard) && Array.isArray(h.used), 'old clients keep the legacy fields');
  cash(5000000);
  g.onAction(p, { action: 'yard_order', variant: 'ultramax64', yard: 'yzj' });
  assert.equal(p.office.orders.length, 1);
  const you = lastYou(ws);
  assert.equal(you.orders.length, 1); assert.equal(you.orders[0].variant ?? you.orders[0].v ?? 'ultramax64', 'ultramax64');
  assert.ok(lastHarbor(ws).yard.orders.length === 1, 'the harbour sheet is refreshed with the order');
  const o = p.office.orders[0];
  const realNow = Date.now;   // game.tick reads the world clock
  try { Date.now = () => (o.createdAt + 36 * 3600) * 1000; g.tick(1); } finally { Date.now = realNow; }
  assert.equal(o.state, 'building', 'yard.tick runs inside game.tick');
  // open orders count toward the fleet limit (Q3)
  assert.equal(vesselSlotsUsed(p), p.fleet.length + 1);
});

test('game: second-hand and stock purchases through onAction; delivered ships have spec + hist and sell at marketValue', async () => {
  const { g, p, ws, cash } = await realGame();
  g.sendHarbor(p);
  const y = lastHarbor(ws).yard;
  cash(500000000);
  if (y.used.length) {
    const l = y.used[0];
    g.onAction(p, { action: 'yard_buy_used', listingId: l.id, tradeIn: false });
    const v = p.fleet[p.fleet.length - 1];
    assert.equal(v.ship.cls, l.cls); assert.ok(v.spec && v.hist, 'spec + hist');
  }
  if (y.stock.length) {
    const s = y.stock[0], n = p.fleet.length;
    g.onAction(p, { action: 'yard_buy_stock', stockId: s.id, tradeIn: false });
    assert.equal(p.fleet.length, n + 1);
  }
  // catalogue models are not sold through the legacy buy path (H1 resolves them, but they are ordered at a yard)
  const n0 = p.fleet.length;
  g.onAction(p, { action: 'buy_ship', cls: 'ultramax64', tradeIn: false });
  g.onAction(p, { action: 'buy_ship', cls: 'toString', tradeIn: false });
  assert.equal(p.fleet.length, n0);
  // legacy buy_ship from old clients keeps working
  const n = p.fleet.length;
  g.onAction(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
  assert.equal(p.fleet.length, n + 1);
});
