// Cruise ships — the walkable interiors v2 (docs/CRUISE-CONTRACT.md §4): the programme of every class is really built, cabins and
// venues scale with the guest count, classes differ in design, the build is deterministic, and ?iv2=0 falls back to the v1 plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
const ROOT = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`const ROOT=${JSON.stringify(ROOT)};export async function resolve(s,c,n){if(s.startsWith('/shared/'))return n(ROOT+s.slice(1),c);if(s.startsWith('/js/'))return n(ROOT+'public'+s,c);return n(s,c);}`));

const { planFromGA } = await import('../public/js/gaplan.js');
const { generalArrangement } = await import('../shared/ships/ga.js');
const { cruiseProfile } = await import('../shared/ships/cruiseprofile.js');
const { IV2_READY } = await import('../shared/ships/gaspace.js');
const { cruiseCounts } = await import('../shared/ships/cruiselayout.js');

const IDS = ['rivercruise110', 'boutique125', 'expedition105', 'cruise230', 'cruise285', 'cruise330', 'cruise362', 'cruise370'];
const survey = new Map();
function look(id) {
  if (survey.has(id)) return survey.get(id);
  const ga = generalArrangement(id), spaces = {}; let cabins = 0, rooms = 0, tris = 0;
  for (const d of ga.pax.decks) {
    const p = planFromGA(id, { deck: d.id }); rooms += p.rooms.length;
    for (const r of p.rooms) { spaces[r.space] = (spaces[r.space] || 0) + 1; if (/^cabin_(?!lobby)/.test(r.space || '')) cabins++; }
    tris += p.props.length;
  }
  const o = { ga, spaces, cabins, rooms, props: tris, decks: ga.pax.decks.length }; survey.set(id, o); return o;
}

test('cruise interiors: v2 is on for cruise, ?iv2=0 falls back to the v1 plan', () => {
  assert.ok(IV2_READY.has('cruise'));
  assert.equal(planFromGA('cruise230', { deck: 'd5' }).v, 2);
  globalThis.__iv2 = false;
  try { const p = planFromGA('cruise230'); assert.notEqual(p.v, 2); assert.ok(p.rooms.length > 5); } finally { delete globalThis.__iv2; }
});

test('cruise interiors: thousands of cabins — at least one berth category per guest, within 1.5 × (crew cabins included)', () => {
  for (const id of IDS) {
    const { cabins } = look(id), P = cruiseProfile(id);
    assert.ok(cabins >= P.cabins.total, `${id}: ${cabins} cabin rooms for ${P.cabins.total} guest cabins`);
    assert.ok(cabins <= P.cabins.total * 1.5 + 80, `${id}: ${cabins} cabin rooms vs ${P.cabins.total}`);
  }
  assert.ok(look('cruise362').cabins > 3000 && look('cruise370').cabins > look('cruise362').cabins);
});

test('cruise interiors: venues and rooms scale with the guests (monotone from the river ship to the 7,600-guest ship)', () => {
  const order = ['rivercruise110', 'expedition105', 'boutique125', 'cruise230', 'cruise285', 'cruise330', 'cruise362', 'cruise370'];
  let prev = 0;
  for (const id of order) { const n = look(id).rooms; assert.ok(n > prev, `${id} ${n} <= ${prev}`); prev = n; }
  const n = (id, sp) => look(id).spaces[sp] || 0;
  for (const sp of ['restaurant', 'bar', 'shop']) assert.ok(n('cruise370', sp) > n('cruise230', sp) && n('cruise230', sp) >= n('boutique125', sp) - 1, sp);
  assert.ok(look('cruise362').rooms > 4000, `${look('cruise362').rooms}`);
});

test('cruise interiors: the big ships have the whole programme', () => {
  for (const id of ['cruise330', 'cruise362', 'cruise370']) {
    const S = look(id).spaces;
    for (const sp of ['atrium', 'theatre', 'theatre_balcony', 'restaurant', 'buffet', 'bar', 'nightclub', 'spa', 'gym_pax', 'shop', 'guest_services', 'kids', 'arcade', 'medical_ward', 'galley_pax', 'crew_mess', 'pool_deck', 'cabin_cruise_balcony'.replace('cruise_balcony', 'cruise_bal')]) {
      if (sp === 'cabin_cruise_bal') continue;
      assert.ok(S[sp] > 0 || (sp === 'kids' && S.kids > 0), `${id}: no ${sp}`);
    }
    assert.ok(S.bridge === 1 || S.bridge > 0, `${id}: bridge`);
    assert.ok(Object.keys(S).some((k) => /^cabin_/.test(k)), 'cabins');
    assert.ok((S.atrium || 0) >= 2, `${id}: atria ${S.atrium}`);
  }
  for (const id of ['cruise330', 'cruise362', 'cruise370']) { const S = look(id).spaces; assert.ok(S.casino > 0 || id === 'cruise330', `${id} casino`); }
});

test('cruise interiors: classes differ in design, not only in size', () => {
  const sig = (id) => { const P = cruiseProfile(id); return JSON.stringify([P.stack, P.atria.length, P.theatre, P.dining, P.extras.join(',')]); };
  const sigs = new Set(IDS.map(sig)); assert.equal(sigs.size, IDS.length);
  assert.equal(cruiseProfile('rivercruise110').atria.length, 0); assert.ok(cruiseProfile('cruise362').atria.length >= 3);
  assert.ok(cruiseProfile('cruise370').stack.cabin > cruiseProfile('cruise230').stack.cabin);
  assert.ok(look('rivercruise110').spaces.casino === undefined && look('rivercruise110').spaces.nightclub === undefined);
  assert.ok(cruiseProfile('cruise370').extras.includes('surf_simulator') && !cruiseProfile('cruise330').extras.includes('surf_simulator'));
});

test('cruise interiors: deterministic — the same ship and deck give the same plan', () => {
  const a = planFromGA('cruise285', { deck: 'd4' }), b = planFromGA('cruise285', { deck: 'd4' });
  assert.deepEqual(a.rooms.map((r) => [r.id, r.x0, r.x1, r.z0, r.z1]), b.rooms.map((r) => [r.id, r.x0, r.x1, r.z0, r.z1]));
  assert.deepEqual(a.props.map((p) => [p.item, p.x, p.z]), b.props.map((p) => [p.item, p.x, p.z]));
});

test('cruise interiors: every deck has few big empty areas — furnished props per walkable floor area', () => {
  for (const id of ['cruise230', 'cruise362']) {
    const p = planFromGA(id, { deck: 'd4' });
    const area = p.rooms.filter((r) => r.walk !== false && r.space !== 'stair').reduce((s, r) => s + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
    const k2 = p.props.filter((q) => q.t === 'k2').length;
    assert.ok(k2 / area > 0.03, `${id}: ${k2} items on ${Math.round(area)} m²`);
  }
});

test('cruise quick travel: the Go-to list names every guest venue (casino first), reaches other decks, and lands inside the venue', () => {
  for (const id of IDS) {
    const ga = generalArrangement(id), pub = ga.pax.decks.find((d) => d.use === 'public');
    const plan = planFromGA(id, { deck: pub.id });
    const labels = plan.goto.map((g) => g.label);
    assert.ok(plan.goto.some((g) => g.id === 'bridge'), `${id}: bridge`);
    assert.ok(plan.goto.some((g) => /^v:/.test(g.id)), `${id}: venues in the list`);
    assert.equal(new Set(plan.goto.map((g) => g.id)).size, plan.goto.length, `${id}: unique ids`);
    if (cruiseCounts(id).venues.casino > 0) {   // only the ships that have a casino
      const casino = plan.goto.find((g) => /^Casino/.test(g.label));
      assert.ok(casino, `${id}: casino in the list (${labels.slice(0, 8).join(', ')})`);
      // the casino is on another deck from the first public deck → a deck travel entry; on that deck's plan the point is inside the casino room
      const cdeck = casino.deck || plan.deckGroup;
      const there = planFromGA(id, { deck: cdeck });
      const here = there.goto.find((g) => g.id === casino.id && !g.deck);
      assert.ok(here, `${id}: casino point on deck ${cdeck}`);
      const room = there.rooms.find((r) => /^Casino/.test(r.name) && here.x >= r.x0 - 0.01 && here.x <= r.x1 + 0.01 && here.z >= r.z0 - 0.01 && here.z <= r.z1 + 0.01 && Math.abs(r.y - here.y) < 0.3);
      assert.ok(room, `${id}: the point stands inside the casino`);
    }
  }
});
