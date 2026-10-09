// Lane C (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6, §9 item 9): the general arrangement of every catalogue ship —
// real rules (SOLAS V/22 sight line, SOLAS II-1/9 double bottom, MLC A3.1 cabins and hospital, SOLAS III/31 lifesaving,
// SOLAS V/19 bridge equipment) and the engine sizes of §6.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generalArrangement, blindDistance, meDims, doubleBottom, hullHalf, deckHalf, outlineHalf, cabinArea, GA_GENS, hasGA } from '../shared/ships/ga.js';
import { MODELS } from '../shared/ships/catalogue.js';

const IDS = Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail');
const GA = new Map(IDS.map((id) => [id, generalArrangement(id)]));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const rooms = (ga) => (ga.house?.tiers || []).flatMap((t) => t.rooms.map((r) => ({ ...r, tier: t })));

test('ga: every non-sail model has a generator; the sail classes are delegated to the sailing code', () => {
  assert.equal(GA_GENS.length, 13);
  for (const id of IDS) { const ga = GA.get(id); assert.ok(ga && GA_GENS.includes(ga.gen), `${id}: no GA`); assert.ok(hasGA(id)); }
  for (const id of ['sloop', 'ketch', 'catamaran', 'schooner']) { const ga = generalArrangement(id); assert.equal(ga.gen, 'sail'); assert.equal(ga.delegate, 'sailing'); assert.equal(hasGA(id), false); }
  assert.equal(generalArrangement('nonsense'), null);
});

test('ga: pure and deterministic — the same variant gives the same frozen record; variants resolve', () => {
  const a = generalArrangement('ultramax64'), b = generalArrangement('ultramax64');
  assert.equal(a, b);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.house.tiers[0].rooms[0]));
  const v = generalArrangement('ultramax64~lng.i1c.esd');
  assert.equal(v.model, 'ultramax64'); assert.equal(v.id, 'ultramax64~lng.i1c.esd');
  assert.deepEqual(JSON.parse(JSON.stringify(generalArrangement('kamsarmax82', { stage: 1 }))), JSON.parse(JSON.stringify(GA.get('kamsarmax82'))));
  assert.equal(generalArrangement('kamsarmax82~i1a').bridge.wings, 'enclosed');   // ice class: enclosed bridge wings
  assert.equal(GA.get('kamsarmax82').bridge.wings, 'open');
});

test('ga: §9-9 engine sizes — ULCV 21.0 × 4.9 × 17.7 m, Ultramax 10.5 × 3.1 × 12.2 m, and they fit between the double bottom and the main deck', () => {
  const u = GA.get('ulcv24k').er.me, m = GA.get('ultramax64').er.me;
  near(u.len, 21.0, 0.05, 'ulcv len'); near(u.w, 4.9, 0.05, 'ulcv w'); near(u.h, 17.7, 0.05, 'ulcv h');
  near(m.len, 10.5, 0.05, 'ultramax len'); near(m.w, 3.1, 0.05, 'ultramax w'); near(m.h, 12.2, 0.05, 'ultramax h');
  for (const id of ['ulcv24k', 'ultramax64', 'kamsarmax82', 'capesize180', 'vlcc300', 'lng174k', 'neopmax14k']) {
    const ga = GA.get(id), er = ga.er;
    assert.ok(er.floorY + er.me.h <= ga.deckY + 0.01, `${id}: engine ${er.me.h} m does not fit (floor ${er.floorY}, deck ${ga.deckY})`);
    near(er.floorY, -ga.T + ga.db, 0.01, `${id}: ER floor on the double bottom`);
  }
  assert.deepEqual(meDims('2s', 59000), { len: 21, w: 4.91, h: 17.68 });
});

test('ga: double bottom B/20 within 1.0–2.0 m (SOLAS II-1/9): ULCV 2.0, Ultramax 1.61', () => {
  assert.equal(GA.get('ulcv24k').db, 2.0); assert.equal(GA.get('ultramax64').db, 1.61);
  assert.equal(doubleBottom(14), 1.0); assert.equal(doubleBottom(65), 2.0);
});

test('ga: SOLAS V/22 — the sea is visible within min(2 L, 500 m) ahead of the bow over the stacks, cranes and forecastle', () => {
  for (const id of IDS) {
    const ga = GA.get(id);
    if (!ga.house || ga.layout !== 'big' || ga.yacht) continue;
    const bd = blindDistance(ga), lim = Math.min(2 * ga.L, 500);
    assert.ok(bd <= lim + 0.5, `${id}: blind distance ${bd.toFixed(0)} m > ${lim} m (eye ${ga.house.eyeY} m)`);
  }
  // container ships: the stacks right ahead of the bridge are at their full height, those further forward step down
  for (const id of IDS.filter((k) => MODELS[k].gen === 'container')) {
    const ga = GA.get(id), fwd = ga.cargo.zones.filter((b) => b.fwd);
    assert.ok(fwd.length >= 2, `${id}: bays`);
    assert.ok(fwd[fwd.length - 1].tiers >= fwd[0].tiers, `${id}: stacks rise toward the bridge`);
    assert.ok(Math.max(...ga.cargo.zones.map((b) => b.tiers)) === ga.cargo.tiersOnDeck, `${id}: full stacks somewhere`);
  }
  assert.equal(GA.get('ulcv24k').house.pos, 'mid');   // ≥ 14,000 TEU: twin island, house 0.62 L from the stern
  near(GA.get('ulcv24k').house.z0 + GA.get('ulcv24k').house.z1, 2 * (399.9 / 2 - 0.62 * 399.9), 25, 'twin-island house position');
});

test('ga: MLC A3.1 — one cabin per crew + 2, cabin floors, day rooms, hospital iff crew ≥ 15, gym ≥ 10,000 GT', () => {
  for (const id of IDS) {
    const ga = GA.get(id);
    if (!ga.house || ga.layout === 'pax' || ga.yacht) continue;
    const rs = rooms(ga), berths = rs.filter((r) => r.berth).length;
    if (['aft_house_dry', 'aft_house_tanker', 'lng', 'container', 'roro_pctc'].includes(ga.gen)) assert.equal(berths, ga.crew.opt + 2, `${id}: ${berths} berths for crew ${ga.crew.opt}`);
    else assert.ok(berths >= ga.crew.opt + 2, `${id}: ${berths} berths for crew ${ga.crew.opt}`);
    for (const r of rs.filter((q) => q.berth)) {
      const area = (r.x1 - r.x0) * (r.z1 - r.z0), min = cabinArea(ga.gt, r.officer);
      assert.ok(area >= min, `${id}: ${r.name} ${area.toFixed(1)} m² < ${min}`);
    }
    assert.equal(rs.some((r) => r.use === 'hospital'), ga.crew.opt >= 15, `${id}: hospital (crew ${ga.crew.opt})`);
    if (ga.gt >= 3000) for (const who of ['Master', 'Chief engineer', 'Chief officer']) assert.ok(rs.some((r) => r.use === 'dayroom' && r.name.startsWith(who)), `${id}: no day room for the ${who}`);
    if (ga.gt >= 10000) assert.ok(rs.some((r) => r.use === 'gym'), `${id}: no gym`);
    assert.ok(rs.some((r) => r.use === 'galley') && rs.some((r) => r.use === 'mess'), `${id}: galley + mess`);
  }
  assert.equal(GA.get('tug24').crew.hospital, false);
  assert.equal(GA.get('cruise330').crew.hospital, true);
});

test('ga: SOLAS V/19 bridge — steering stand, X-band (and S-band ≥ 3,000 GT) radar, ECDIS ×2, conning, telegraph, GMDSS, chart table; wings to the side', () => {
  for (const id of IDS) {
    const ga = GA.get(id);
    if (!ga.bridge || ga.bridge.small) continue;
    const k = new Set(ga.bridge.consoles.map((c) => c.kind));
    for (const need of ['steering', 'radar', 'ecdis', 'conning', 'telegraph', 'gmdss', 'chart']) assert.ok(k.has(need), `${id}: no ${need}`);
    if (ga.gt >= 3000) assert.ok(ga.bridge.consoles.some((c) => c.band === 'S'), `${id}: no S-band radar`);
    if (ga.bridge.x1 - ga.bridge.x0 > 7) assert.equal(ga.bridge.consoles.filter((c) => c.kind === 'ecdis').length, 2, `${id}: ECDIS ×2`);
    if (ga.bridge.wings !== 'none' && !ga.yacht) {
      if (ga.layout === 'pax') assert.ok(ga.bridge.wingTo >= ga.B / 2 - 0.3, `${id}: wing reach ${ga.bridge.wingTo}`);   // cruise wings stand out over the side
      else near(ga.bridge.wingTo, ga.B / 2 - 0.3, 0.6, `${id}: wing reach`);
    }
  }
  for (const id of ['ahts85', 'psv90', 'sov90', 'oceantug60']) assert.ok(GA.get(id).bridge.aftConsole, `${id}: aft-facing console over the deck`);
});

test('ga: SOLAS III/31 lifesaving — free-fall lifeboat on bulk carriers, tankers and container ships; davits on ferries and cruise ships', () => {
  for (const id of IDS) {
    const ga = GA.get(id), kinds = new Set(ga.deck.boats.map((b) => b.kind));
    if (['bulk', 'tanker', 'container'].includes(MODELS[id].type)) assert.ok(kinds.has('freefall'), `${id}: no free-fall lifeboat`);
    if (['ropax200', 'ferry', 'cruise230', 'cruise330', 'cruise362', 'expedition105'].includes(id)) assert.ok(kinds.has('davit'), `${id}: no davit lifeboats`);
  }
});

test('ga: engine room — levels every ≤ 4.5 m, engine control room on the upper platform, steering gear aft, room for the engines', () => {
  for (const id of IDS) {
    const ga = GA.get(id), er = ga.er;
    if (!er || er.small) continue;
    for (let i = 1; i < er.levels.length; i++) assert.ok(er.levels[i] - er.levels[i - 1] <= 4.51 + (ga.L < 100 ? 0 : 0), `${id}: ER levels ${er.levels}`);
    if (ga.layout === 'big' && !ga.yacht) { assert.equal(er.ecr.level, er.levels.length - 1, `${id}: ECR level`); assert.ok(er.steering && er.steering.z1 > er.steering.z0, `${id}: steering gear room`); }
    const span = er.me.len * er.me.rows + 1.2 * (er.me.rows - 1);
    assert.ok(er.z1 - er.z0 >= span + 2, `${id}: ER ${(er.z1 - er.z0).toFixed(1)} m for ${span.toFixed(1)} m of engines`);
  }
});

test('ga: one hull for outside and inside — the deck edge, sections inside it, outline from transom to stem', () => {
  for (const id of IDS) {
    const ga = GA.get(id);
    near(deckHalf(ga, (ga.hull.mid[0] + ga.hull.mid[1]) / 2), ga.B / 2, 0.01, `${id}: midship half-beam`);
    for (const z of [-ga.L * 0.45, -ga.L * 0.2, 0, ga.L * 0.3, ga.L * 0.48]) for (const y of [ga.deckY, 0, -ga.Tk * 0.5, -ga.Tk + 0.05]) assert.ok(hullHalf(ga, z, y) <= deckHalf(ga, z) + 1e-9, `${id}: section wider than the deck at ${z}, ${y}`);
    const o = outlineHalf(ga);
    for (let i = 1; i < o.length; i++) assert.ok(o[i][1] < o[i - 1][1], `${id}: outline not monotonic`);
    near(o[0][1], ga.L / 2, 0.01, `${id}: outline starts at the transom`); near(o[o.length - 1][1], -ga.L / 2, 0.01, `${id}: outline ends at the stem`);
  }
});

test('ga: Go-to targets for every big ship (bridge, engine control room, engine room, mess, cabin, bow, stern + the type\'s own)', () => {
  const want = { aft_house_dry: ['hold'], aft_house_tanker: ['manifold', 'ccr'], lng: ['compressor', 'ccr'], container: ['lashing'], cruise: ['lido', 'theatre', 'reception', 'boatdeck'], ferry: ['cardeck', 'reception', 'boatdeck'] };
  for (const id of IDS) {
    const ga = GA.get(id);
    if (ga.L <= 60 || ga.layout === 'small') continue;
    const ids = new Set(ga.goto.map((g) => g.id));
    for (const k of ['bridge', 'bow', 'stern']) assert.ok(ids.has(k), `${id}: no go-to ${k}`);
    if (ga.layout === 'big' && !ga.yacht) for (const k of ['ecr', 'er', 'mess', 'cabin']) assert.ok(ids.has(k), `${id}: no go-to ${k}`);
    for (const k of want[ga.gen] || []) if (!(ga.gen === 'aft_house_dry' && MODELS[id].id === 'livestock135')) assert.ok(ids.has(k), `${id}: no go-to ${k}`);
  }
});

test('ga: passenger ships — deck stacks, main vertical zones ≤ 48 m, stair towers, the bridge on a high deck forward', () => {
  for (const id of ['expedition105', 'cruise230', 'cruise330', 'cruise362', 'ferry50', 'ferry', 'hsc112', 'ropax200']) {
    const ga = GA.get(id), X = ga.pax;
    assert.ok(X.decks.length >= 3, `${id}: decks`);
    assert.ok((ga.L * 0.86) / X.mvz <= 48.01, `${id}: MVZ`);
    assert.ok(X.towers.length >= 1);
    for (let i = 1; i < X.decks.length; i++) assert.ok(X.decks[i].y > X.decks[i - 1].y + 2.3, `${id}: deck heights`);
    assert.ok(ga.bridge.z0 < -ga.L * 0.3, `${id}: bridge forward`);
  }
  assert.equal(GA.get('cruise362').pax.decks.length, 18);
  assert.ok(GA.get('cruise362').pax.perDeck && GA.get('ropax200').pax.perDeck && !GA.get('ferry').pax.perDeck);
  assert.ok(GA.get('ropax200').pax.carDecks.length === 2 && GA.get('pctc7000').roro.decks.length >= 6);
});
