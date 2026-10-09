// Dock anywhere — the client card's content (public/js/quayfmt.js): fit rows, price, approach greying, services by
// tier, the slot outline, the moored panel, and the HTML (escaped, buttons the quayui.js binds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardModel, cardHTML, mooredModel, mooredHTML, pickCandidate, slotOutline, faceFrame, facePoint, serviceRows, esc } from '../public/js/quayfmt.js';
import { SERVICE_TIERS, TIER_TABS, QUAY } from '../shared/quayrules.js';

// a 600 m quay running due east (water to the south), the 330 m slot of a container ship in its middle
const face = { a: { lat: 51.95, lon: 4.05 }, hdg: 90, wb: 180 };
face.b = facePoint(face, 600, 0);
const slotA = facePoint(face, 135, 0), slotB = facePoint(face, 465, 0), slotC = facePoint(face, 300, QUAY.FENDER_M + 21.5);
const cand = (o = {}) => ({
  id: 'q8376.5415.15', slotId: 'q8376.5415.15@300', name: 'Terminal U9 · Rotterdam', cls: 'terminal', clsName: 'Commercial terminal',
  lenM: 600, usableM: 600, needM: 330, depthLW: 14.9, needDepth: 14.7, fits: true, why: null, occupiedBy: null, distM: 40,
  face, slot: { lat: slotC.lat, lon: slotC.lon, hdg: 90, len: 330, beam: 43, a: slotA, b: slotB },
  perDay: 4125, harbor: { id: 'rotterdam', name: 'Rotterdam (Maasvlakte)', size: 'mega', distKm: 4 }, tier: 'port', services: SERVICE_TIERS.port, tabs: TIER_TABS.port,
  tugs: true, tugCost: 38500, ...o,
});

test('face frame round trip and the slot outline (ship footprint off the face)', () => {
  const p = facePoint(face, 200, 30), f = faceFrame(face, p.lat, p.lon);
  assert.ok(Math.abs(f.along - 200) < 0.01 && Math.abs(f.off - 30) < 0.01);
  const o = slotOutline(cand());
  assert.equal(o.length, 4);
  const fr = o.map((q) => faceFrame(face, q.lat, q.lon));
  assert.ok(Math.abs(fr[0].along - 135) < 0.05 && Math.abs(fr[1].along - 465) < 0.05);
  assert.ok(Math.abs(fr[0].off - 1.5) < 0.05 && Math.abs(fr[2].off - 44.5) < 0.05);
  assert.equal(slotOutline({ ...cand(), slot: null }), null);
});

test('card model: rows against the ship, price, moor greyed until alongside, slow and aligned', () => {
  const at = { lat: slotC.lat, lon: slotC.lon, hdg: 271, spd: 1, cls: 'boxship' };
  const m = cardModel(cand(), { ship: at, money: 1e6 });
  assert.equal(m.price, '4,125 cr / day');
  assert.equal(m.moor.ok, true, m.moor.hint);
  assert.deepEqual(m.rows.slice(0, 2).map((r) => r.ok), [true, true]);
  assert.match(m.sub, /Commercial terminal · 4 km from Rotterdam \(Maasvlakte\) · 40 m away/);
  assert.equal(m.tugs.show, true);
  const far = facePoint(face, 300, 200);
  assert.equal(cardModel(cand(), { ship: { ...at, ...far }, money: 1e6 }).moor.ok, false);
  assert.match(cardModel(cand(), { ship: { ...at, spd: 3 }, money: 1e6 }).moor.hint, /Slow below 2 kn/);
  assert.match(cardModel(cand(), { ship: at, money: 100 }).moor.hint, /first day \(4,125 cr\)/);
  assert.match(cardModel(cand(), { ship: at, money: 1e6, hail: true }).moor.hint, /heave to/);
  const no = cardModel(cand({ fits: false, why: 'Too shallow: 3.4 m at low water alongside; you draw 14 m and need 14.7 m.', depthLW: 3.4, slot: null }), { ship: at, money: 1e6 });
  assert.equal(no.moor.ok, false); assert.equal(no.rows[1].ok, false); assert.match(no.why, /Too shallow/); assert.equal(no.tugs.show, false);
});

test('services by tier and the harbour tabs a quay reaches', () => {
  const port = serviceRows('port'), near = serviceRows('near'), none = serviceRows('none');
  assert.ok(port.every((r) => r.ok));
  assert.deepEqual(near.filter((r) => !r.ok).map((r) => r.id), ['shipyard']);
  assert.match(near.find((r) => r.id === 'market').note, /truck, buy \+6 %/);
  assert.match(near.find((r) => r.id === 'fuel').note, /\+12 %, ≤ 400 t/);
  assert.match(near.find((r) => r.id === 'jobs').note, /deliver at the harbour/);
  assert.ok(none.every((r) => !r.ok));
  assert.ok(!TIER_TABS.near.includes('shipyard') && TIER_TABS.port.includes('shipyard'));
});

test('pickCandidate keeps the skipper\'s choice, else the first that fits', () => {
  const a = cand({ id: 'a', fits: false }), b = cand({ id: 'b' }), c = cand({ id: 'c' });
  assert.equal(pickCandidate([a, b, c], 'c').id, 'c');
  assert.equal(pickCandidate([a, b, c], 'gone').id, 'b');
  assert.equal(pickCandidate([a], null).id, 'a');
  assert.equal(pickCandidate([], 'x'), null);
});

test('HTML: escaped, the buttons quayui binds, tabs disabled until moored', () => {
  const evil = cand({ name: '<img src=x onerror=alert(1)>' });
  const m = cardModel(evil, { ship: { lat: slotC.lat, lon: slotC.lon, hdg: 90, spd: 0, cls: 'boxship' }, money: 1e6 });
  const html = cardHTML(m, { index: 1, count: 3, docked: false });
  assert.ok(!html.includes('<img'), 'name escaped'); assert.ok(html.includes(esc('<img src=x onerror=alert(1)>')));
  for (const q of ['moor', 'tugs', 'prev', 'next', 'close', 'tab:market', 'tab:shipyard']) assert.ok(html.includes(`data-q="${q}"`), q);
  assert.ok(html.includes('2 / 3'));
  assert.match(html, /data-q="tab:market" disabled/);
  assert.match(cardHTML(m, { docked: true }), /data-q="tab:market" >/);
});

test('moored panel: days, what is due on casting off, tabs, cast off', () => {
  const berth = { quay: true, name: 'Industrial AO · Rotterdam', perDay: 1760, paid: 1760, since: 1000, tier: 'near', harbor: 'rotterdam' };
  const m = mooredModel(berth, 1000 + 2.5 * 86400);
  assert.equal(m.days, 3); assert.equal(m.total, 5280); assert.equal(m.due, 3520);
  assert.match(m.line, /1,760 cr \/ day · day 3 · 3,520 cr due when you cast off/);
  const html = mooredHTML(m, ['market', 'office']);
  assert.ok(html.includes('data-q="castoff"') && html.includes('pay 3,520 cr') && html.includes('data-q="tab:office"'));
  assert.match(mooredModel(berth, 1000 + 3600).line, /paid up/);
  assert.equal(mooredModel({ harbor: 'x' }, 0), null);
});
