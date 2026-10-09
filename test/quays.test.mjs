// Dock anywhere (docs/DOCK-ANYWHERE-CONTRACT.md): the shared rules (shared/quayrules.js) and the berth finder
// (server/quays.js) on the recorded Rotterdam world tiles (test/fixtures/wt/rotterdam: OpenFreeMap z14 + overlay +
// bathy, converted by server/wtconvert.js exactly as production does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPoints, loadPortFixture, FIXTURE_DIR } from './fixtures/wt/lib.mjs';
import {
  createQuayFinder, queryQuays, fitRun, dockCheck, tugCheck, runFrame, runPoint, occupiedIntervals, quayBerth,
  quayUndockPoint, collectOccupants, clipSeg, straightRuns, mergeCollinear, chainSegments, makeSampler, quayName,
} from '../server/quays.js';
import {
  QUAY, SERVICE_TIERS, neededLength, neededDepth, neededWidth, offsetsFor, quayFeePerDay, baseBerthFee, stayFee,
  balanceDue, daysAlongside, serviceTier, linkHarbour, tugsAvailable, quayTugCost, quayDenies, serviceMul, approachWhy,
} from '../shared/quayrules.js';
import { SHIP_CLASSES, FEES } from '../shared/constants.js';
import { WT_NAVIGABLE, WT_OBSTACLE } from '../shared/wtformat.js';
import { HARBORS } from '../server/harbors.js';

const { ports } = loadPoints();
let FX = null;
const fixture = () => (FX ||= loadPortFixture(FIXTURE_DIR, ports.find((p) => p.id === 'rotterdam')));
const getTile = (z, x, y) => (z === 14 ? fixture().tiles.get(`${x}/${y}`) || null : null);
const newFinder = (o = {}) => createQuayFinder({ getTile, harbors: HARBORS, ...o });
const allRuns = (finder) => { const out = []; for (const k of [...fixture().tiles.keys()].sort()) { const [x, y] = k.split('/').map(Number); out.push(...finder.runsFor(x, y)); } return out; };
const hById = (id) => HARBORS.find((h) => h.id === id) || null;

// Points 60 m off three real quays (found once, written down so the tests do not depend on run ids):
const P_TERMINAL = { lat: 51.948952, lon: 4.062297 };   // Maasvlakte container terminal wall, ~800 m, 14.9 m at LW, STS cranes
const P_CITY = { lat: 51.897905, lon: 4.154791 };       // a ~480 m river quay south of the Nieuwe Waterweg, 3.4 m, bridges
const P_NARROW = { lat: 51.923143, lon: 4.194551 };     // a ~340 m pier face in a narrow basin, outside the port limits
/** The run whose face the point lies off (0 < off ≤ 120 m, inside its length), nearest first. */
function runOff(finder, p) {
  const { runs } = finder.runsNear(p.lat, p.lon, 300, 99);
  return runs.map((r) => ({ r, f: runFrame(r, p.lat, p.lon) })).filter(({ r, f }) => f.off > 0 && f.off <= 120 && f.along >= 0 && f.along <= r.len)
    .sort((a, b) => a.f.off - b.f.off || b.r.len - a.r.len)[0]?.r || null;
}

// ------------------------------------------------------------------------------------------------ rules
test('rules: length, depth and width a ship needs', () => {
  assert.equal(neededLength('boxship'), 330);            // 300 m + 10 %
  assert.equal(neededLength('sloop'), 21);               // 11 m + 10 m minimum
  assert.equal(neededDepth('boxship'), 14.7);            // 14 m draught + 5 %
  assert.equal(neededDepth('sloop'), 2.2);               // 1.9 m + 0.3 m minimum
  assert.equal(neededWidth('boxship'), 49);
  assert.deepEqual(offsetsFor('boxship'), [0, 1, 2, 3, 4]);   // 4 … 40 m off the face (55 m is beyond 49 m)
  assert.deepEqual(offsetsFor('sloop'), [0]);                // 3.6 m beam + 6 m: the 4 m offset only
});

test('price math is exact', () => {
  assert.equal(baseBerthFee('boxship'), Math.round(110000 * FEES.BERTH_PER_T_DAY));   // 2 200 = server/economy.js berthFeePerDay
  assert.equal(quayFeePerDay('boxship', 'terminal', { size: 'mega', tier: 'port' }), 4125);          // 2200 × 1.5 × 1.25
  assert.equal(quayFeePerDay('boxship', 'terminal', { size: 'mega', tier: 'port', home: true }), 2063); // × 0.5, rounded
  assert.equal(quayFeePerDay('boxship', 'industrial', { size: 'mega', tier: 'near' }), 1760);        // 2200 × 1.0 × 0.8
  assert.equal(quayFeePerDay('boxship', 'industrial', { size: 'mega', tier: 'near', home: true }), 1760); // no home rebate outside the port
  assert.equal(quayFeePerDay('feeder', 'city', { size: 'regional', tier: 'port' }), 364);           // 280 × 1.3 × 1.0
  assert.equal(quayFeePerDay('coaster', 'quay', { size: 'minor', tier: 'port' }), 52);              // 64 × 0.9 × 0.9 = 51.84
  assert.equal(quayFeePerDay('sloop', 'marina', { size: 'mega', tier: 'port' }), QUAY.MIN_FEE);      // 0.12 × … → the 25 cr minimum
  assert.equal(daysAlongside(0), 1); assert.equal(daysAlongside(86400), 1); assert.equal(daysAlongside(86401), 2);
  assert.equal(stayFee(4125, 2.5 * 86400), 12375);
  assert.equal(balanceDue(4125, 2.5 * 86400, 4125), 8250);      // day 1 was paid when the lines went ashore
  assert.equal(balanceDue(4125, 3600, 4125), 0);
  assert.equal(quayTugCost('boxship', 'port'), Math.round(110000 * FEES.TUG_PER_T));
  assert.equal(quayTugCost('boxship', 'near'), Math.round(Math.round(110000 * FEES.TUG_PER_T) * 1.5));
  assert.equal(quayTugCost('sloop', 'port'), FEES.TUG_MIN);
});

test('services: tiers by distance to the linked harbour, what each tier allows', () => {
  const rot = HARBORS.find((h) => h.id === 'rotterdam');
  assert.equal(serviceTier(rot, 11.9), 'port'); assert.equal(serviceTier(rot, 12.1), 'near');
  assert.equal(serviceTier({ size: 'minor' }, 3.5), 'near'); assert.equal(serviceTier(rot, 40), 'remote'); assert.equal(serviceTier(rot, 61), 'none');
  const l = linkHarbour(HARBORS, 51.92, 4.19); assert.equal(l.harbor.id, 'rotterdam'); assert.ok(l.dKm > 12 && l.dKm < 14.5);
  assert.equal(serviceMul('port', 'market'), 1); assert.equal(serviceMul('near', 'fuel'), 1.12); assert.equal(serviceMul('near', 'shipyard'), null);
  assert.equal(serviceMul('remote', 'market'), null); assert.equal(serviceMul('remote', 'office'), 1); assert.equal(serviceMul('none', 'fuel'), null);
  assert.equal(tugsAvailable('near', rot), true); assert.equal(tugsAvailable('near', { size: 'regional' }), false); assert.equal(tugsAvailable('remote', rot), false);
  assert.equal(quayDenies(null, 'shipyard'), null);                                   // harbour berths: everything
  assert.equal(quayDenies({ quay: true, tier: 'port' }, 'shipyard'), null);
  assert.match(quayDenies({ quay: true, tier: 'near', hdKm: 13 }, 'shipyard', 'Rotterdam'), /shipyard is not available.*Sail to Rotterdam, 13 km away/i);
  assert.equal(SERVICE_TIERS.near.deliver, false);
});

test('approach rules for making fast', () => {
  const ok = { lateralM: 5, alongM: 10, hdgDiffDeg: 182, spdKn: 1, cls: 'boxship' };
  assert.equal(approachWhy(ok), null);                                                 // either way round
  assert.match(approachWhy({ ...ok, spdKn: 3 }), /Slow below 2 kn/);
  assert.match(approachWhy({ ...ok, lateralM: 55 }), /55 m off the berth line/);
  assert.match(approachWhy({ ...ok, alongM: 90 }), /90 m/);
  assert.equal(approachWhy({ ...ok, alongM: 70 }), null);                              // L / 4 = 75 m for 300 m
  assert.match(approachWhy({ ...ok, hdgDiffDeg: 40 }), /40° off/);
});

// ------------------------------------------------------------------------------------------------ geometry helpers
test('geometry helpers: clip, straight runs, chaining, collinear merge of a staircase', () => {
  assert.deepEqual(clipSeg(-10, 5, 10, 5, 100), [0, 5, 10, 5]);
  assert.equal(clipSeg(-10, -5, -1, -5, 100), null);
  const runs = straightRuns([[0, 0], [100, 1], [200, 0], [200, 100]]);
  assert.equal(runs.length, 2); assert.deepEqual(runs[0], [0, 0, 200, 0]);
  const lines = chainSegments([[0, 0, 50, 0, 'quay'], [51, 0.5, 100, 0, 'quay'], [100, 0, 100, 50, 'pier']]);
  assert.equal(lines.length, 2); assert.equal(lines[0].pts.length, 3);
  // a wall at 8° drawn as 60 m flat steps with 10 m gaps (what the converter derives from a sloping raster boundary)
  const pieces = []; for (let i = 0; i < 12; i++) { const x = i * 70, z = -i * 70 * Math.tan(8 * Math.PI / 180); pieces.push({ r: [x, z, x + 60, z], kind: 'quay' }); }
  const m = mergeCollinear(pieces);
  assert.equal(m.length, 1, 'one wall');
  assert.ok(Math.hypot(m[0].r[2] - m[0].r[0], m[0].r[3] - m[0].r[1]) > 800);
  // opposite faces of a narrow pier never merge (pieces are oriented: water on the right)
  assert.equal(mergeCollinear([{ r: [0, 0, 100, 0], kind: 'pier' }, { r: [100, 6, 0, 6], kind: 'pier' }]).length, 2);
});

// ------------------------------------------------------------------------------------------------ real quays (Rotterdam)
test('Rotterdam: berths are found along the real quay walls, water on the right side, deterministic', () => {
  const finder = newFinder(), runs = allRuns(finder);
  assert.ok(runs.length > 300, `${runs.length} runs`);
  const long = runs.filter((r) => r.len >= 300);
  assert.ok(long.length >= 10, `${long.length} runs ≥ 300 m`);
  const sample = makeSampler(getTile);
  let good = 0, tot = 0;
  for (const r of long) {
    for (let k = 0; k < r.cut.length; k++) {
      const s = (k + 0.5) * r.step, w = runPoint(r, s, 8), l = runPoint(r, s, -8);
      const sw = sample(w.lat, w.lon), sl = sample(l.lat, l.lon); if (!sw || !sl) continue;
      tot++; if (WT_NAVIGABLE[sw.mask] && WT_OBSTACLE[sl.mask]) good++;
    }
  }
  assert.ok(good / tot >= 0.85, `water 8 m off the face and land 8 m behind it at ${good}/${tot} steps`);
  const classes = new Set(runs.map((r) => r.cls));
  for (const c of ['terminal', 'industrial', 'city', 'quay']) assert.ok(classes.has(c), `class ${c} present`);
  const t = runOff(finder, P_TERMINAL); assert.ok(t, 'the terminal wall'); assert.equal(t.cls, 'terminal'); assert.ok(t.len > 600, `${t.len} m`); assert.equal(t.tier, 'port'); assert.equal(t.harbor, 'rotterdam');
  // same tiles → same runs, ids and geometry, whoever asks
  const again = allRuns(newFinder());
  assert.deepEqual(again.map((r) => [r.id, r.len, r.aLat, r.aLon, r.cls]), runs.map((r) => [r.id, r.len, r.aLat, r.aLon, r.cls]));
});

test('Rotterdam: a container ship fits only where the quay is long and deep enough', () => {
  const finder = newFinder(), runs = allRuns(finder);
  const fitN = (cls) => runs.filter((r) => fitRun(r, { lat: r.mLat, lon: r.mLon, hdg: r.hdg, cls }).fits).length;
  const box = fitN('boxship'), coaster = fitN('coaster'), sloop = fitN('sloop');
  assert.ok(box >= 2, `${box} quays take a 300 m container ship`);
  assert.ok(box < coaster && coaster < sloop, `boxship ${box} < coaster ${coaster} < sloop ${sloop}`);
  const need = neededDepth('boxship'), offs = offsetsFor('boxship');
  for (const r of runs) {
    const f = fitRun(r, { lat: r.mLat, lon: r.mLon, hdg: r.hdg, cls: 'boxship' });
    if (!f.fits) continue;
    assert.ok(r.len >= 330 && f.usable >= 330, `${r.id}: ${r.len} m quay, ${f.usable} m usable`);
    assert.ok(f.depthLW >= need, `${r.id}: ${f.depthLW} m at LW`);
    const k0 = Math.floor((f.slot.s - 165) / r.step), k1 = Math.floor((f.slot.s + 165 - 1e-6) / r.step);
    let deep = 0;
    for (let k = k0; k <= k1; k++) {
      if (Math.min(...offs.map((i) => r.prof[k][i])) >= need) { deep++; continue; }
      // a shallow step inside a slot is only ever a face notch: everything beyond the 10 m face band is deep
      for (const i of offs) if (QUAY.OFFSETS_M[i] > QUAY.FACE_BAND_M) assert.ok(r.prof[k][i] >= need, `${r.id} step ${k} offset ${QUAY.OFFSETS_M[i]} m: ${r.prof[k][i]} m`);
    }
    assert.ok(deep / (k1 - k0 + 1) >= 0.8, `${r.id}: ${deep}/${k1 - k0 + 1} slot steps deep`);
  }
  // the terminal: fits, with the slot on the quay, 1.5 m fenders + half the beam off the face
  const t = runOff(finder, P_TERMINAL), ft = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  assert.equal(ft.fits, true, ft.why);
  const sf = runFrame(t, ft.slot.lat, ft.slot.lon);
  assert.ok(Math.abs(sf.off - (QUAY.FENDER_M + 43 / 2)) < 0.5, `slot ${sf.off} m off the face`);
  assert.ok(ft.slot.s - 165 >= 0 && ft.slot.s + 165 <= t.len);
  // the shallow river quay takes a sloop, not a container ship, not a coaster
  const c = runOff(finder, P_CITY);
  const fc = fitRun(c, { ...P_CITY, hdg: c.hdg, cls: 'boxship' });
  assert.equal(fc.fits, false); assert.match(fc.why, /^Too (short|shallow|narrow)/);
  assert.equal(fitRun(c, { ...P_CITY, hdg: c.hdg, cls: 'coaster' }).fits, false);
  assert.equal(fitRun(c, { ...P_CITY, hdg: c.hdg, cls: 'sloop' }).fits, true);
  // the pier in a narrow basin: too narrow for the container ship's 43 m beam
  const n = runOff(finder, P_NARROW), fn = fitRun(n, { ...P_NARROW, hdg: n.hdg, cls: 'boxship' });
  assert.equal(fn.fits, false); assert.match(fn.why, /Too narrow.*49 m/);
});

test('Rotterdam: occupied quays are refused, the free part still fits a smaller ship, far hulls do not count', () => {
  const finder = newFinder(), t = runOff(finder, P_TERMINAL);
  const ship = { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' };
  const free = fitRun(t, ship);
  assert.equal(free.fits, true);
  // a 250 m AIS vessel moored in the middle of the free stretch
  const mid = runPoint(t, free.slot.s, 1.5 + 20), ais = { id: 'ais244000000', name: 'MSC TEST', lat: mid.lat, lon: mid.lon, hdg: t.hdg, len: 250, beam: 40, kind: 'ais' };
  const occ = fitRun(t, ship, { occupants: [ais] });
  assert.equal(occ.fits, false); assert.match(occ.why, /^Occupied: MSC TEST lies here/); assert.equal(occ.occupiedBy.kind, 'ais');
  // a coaster still finds room beside her, and its slot does not overlap her hull
  const co = fitRun(t, { ...ship, cls: 'coaster' }, { occupants: [ais] });
  assert.equal(co.fits, true, co.why);
  const [iv] = occupiedIntervals(t, [ais], neededWidth('coaster'));
  assert.ok(co.slot.s + 50 <= iv.s0 + 1e-6 || co.slot.s - 50 >= iv.s1 - 1e-6, `slot ${co.slot.s} clear of [${iv.s0}, ${iv.s1}]`);
  // a ship 300 m out in the basin, or one under way across the quay's end, does not block
  const out = runPoint(t, free.slot.s, 300);
  assert.equal(fitRun(t, ship, { occupants: [{ lat: out.lat, lon: out.lon, hdg: 0, len: 300, beam: 40 }] }).fits, true);
  // a harbour-patch berth on the quay belongs to the harbour's own berth list
  const hb = runPoint(t, free.slot.s, 12);
  const h = fitRun(t, ship, { harbourBerths: [{ lat: hb.lat, lon: hb.lon, hdg: t.hdg, length: 400 }] });
  assert.equal(h.fits, false);
  // a restricted area over the whole quay
  assert.match(fitRun(t, ship, { forbidden: () => true }).why, /restricted area/);
});

test('quay_query: the candidate list near a ship (fits first, price, services of the linked harbour)', () => {
  const finder = newFinder();
  const q = queryQuays(finder, { ...P_TERMINAL, hdg: 78, spd: 0, cls: 'boxship' }, { harbors: HARBORS, maxNew: 99 });
  assert.ok(q.list.length > 0 && q.list.length <= QUAY.MAX_CANDIDATES);
  assert.equal(q.busy, false); assert.equal(q.pending, 0);
  const first = q.list[0];
  assert.equal(first.fits, true);
  for (let i = 1; i < q.list.length; i++) assert.ok(q.list[i - 1].fits >= q.list[i].fits);
  assert.equal(first.cls, 'terminal'); assert.equal(first.perDay, 4125);
  assert.equal(first.harbor.id, 'rotterdam'); assert.equal(first.tier, 'port'); assert.equal(first.tugs, true);
  assert.ok(first.slot && first.slot.len === 330 && first.slot.beam === 43);
  assert.ok(first.tabs.includes('shipyard'));
  assert.match(first.name, /^Terminal [0-9A-Z]{2} · Rotterdam$/);
  for (const c of q.list.filter((c) => !c.fits)) assert.ok(c.why, `${c.id} says why not`);
  // outside the port limits: no shipyard, trucks, lower price
  const n = queryQuays(finder, { ...P_NARROW, hdg: 0, spd: 0, cls: 'coaster' }, { harbors: HARBORS, maxNew: 99 });
  const far = n.list.find((c) => c.tier === 'near');
  assert.ok(far, 'a quay outside the port limits'); assert.equal(far.services.shipyard, false); assert.ok(!far.tabs.includes('shipyard'));
  // the per-query analysis budget: the rest is pending and comes with the next query
  const fresh = newFinder(), p1 = queryQuays(fresh, { ...P_TERMINAL, hdg: 0, cls: 'boxship' }, { harbors: HARBORS, maxNew: 2 });
  assert.ok(p1.pending > 0);
  let p = p1; for (let i = 0; i < 10 && p.pending; i++) p = queryQuays(fresh, { ...P_TERMINAL, hdg: 0, cls: 'boxship' }, { harbors: HARBORS, maxNew: 2 });
  assert.equal(p.pending, 0);
  assert.deepEqual(p.list.map((c) => c.slotId), q.list.map((c) => c.slotId));
});

test('quay_dock / tugs: in range, slow, aligned; the saved berth and the cast-off point', () => {
  const finder = newFinder(), t = runOff(finder, P_TERMINAL);
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  const at = { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg + 3, spd: 1, cls: 'boxship' };
  const ok = dockCheck(finder, at, fit.slot.id, {});
  assert.equal(ok.ok, true, ok.why);
  assert.match(dockCheck(finder, { ...at, spd: 4 }, t.id).why, /Slow below 2 kn/);
  const off = runPoint(t, fit.slot.s, fit.slot.off + 60);
  assert.match(dockCheck(finder, { ...at, ...off }, t.id).why, /off the berth line/);
  assert.match(dockCheck(finder, { ...at, hdg: t.hdg + 60 }, t.id).why, /Line up/);
  assert.match(dockCheck(finder, at, 'q1.2.3').why, /not in range/);
  // tugs from 250 m out on clear water
  const away = runPoint(t, fit.slot.s, 250);
  const tug = tugCheck(finder, { ...away, hdg: 0, spd: 3, cls: 'boxship' }, t.id, { harborById: hById, sample: makeSampler(getTile) });
  assert.equal(tug.ok, true, tug.why); assert.equal(tug.cost, quayTugCost('boxship', 'port'));
  assert.match(tugCheck(finder, { ...away, hdg: 0, spd: 8, cls: 'boxship' }, t.id, { harborById: hById }).why, /below 6 kn/);
  // the berth saved in state, and where she starts when casting off
  const b = quayBerth(t, ok.fit, at, { perDay: 4125, harbor: hById('rotterdam'), simTime: 1000, paid: 4125 });
  assert.equal(b.quay, true); assert.equal(b.harbor, 'rotterdam'); assert.equal(b.tier, 'port'); assert.equal(b.perDay, 4125); assert.equal(b.id, fit.slot.id);
  const u = quayUndockPoint(b), uf = runFrame(t, u.lat, u.lon);
  assert.ok(Math.abs(uf.off - (fit.slot.off + 20)) < 0.5, `cast off ${uf.off} m off the face`);
  assert.equal(quayName(t, hById('rotterdam')), b.name);
});

test('memory guard: shed drops the caches, critical analyses no new tile, cached tiles still answer', () => {
  let lvl = 0, shed = null;
  const guard = { level: () => lvl, onShed: (fn) => { shed = fn; } };
  const finder = newFinder({ guard });
  const [x, y] = [8376, 5415];
  const r1 = finder.runsFor(x, y); assert.ok(r1.length > 0);
  lvl = 4;
  assert.equal(finder.runsFor(8381, 5419), null, 'critical: no new analysis');
  assert.equal(finder.runsFor(x, y), r1, 'cached tile still answers');
  const q = queryQuays(finder, { ...P_CITY, hdg: 0, cls: 'sloop' }, { harbors: HARBORS });
  assert.equal(q.busy, true);
  shed(); assert.equal(finder.stats().runTiles, 0); assert.equal(finder.stats().featTiles, 0);
  lvl = 0; assert.deepEqual(finder.runsFor(x, y).map((r) => r.id), r1.map((r) => r.id));
});

test('collectOccupants: skippers, fleet ships, moored AI and AIS — never the asking ship', () => {
  const me = { id: 'me', ship: { lat: 51.95, lon: 4.06, hdg: 0, cls: 'boxship' }, vessel: { id: 'v-me' } };
  me.vessel.ship = me.ship;
  const other = { id: 'p2', name: 'Anna', ship: { lat: 51.951, lon: 4.061, hdg: 80, cls: 'feeder' } };
  const fleetV = { id: 'v9', name: 'Ever Slow', ship: { lat: 51.949, lon: 4.059, hdg: 80, cls: 'coaster' } };
  const game = {
    byId: new Map([['me', me], ['p2', other]]),
    fleet: { vesselsNear: () => [me.vessel, fleetV, { id: 'v2', ship: other.ship }] },
    traffic: { near: () => [{ id: 'ai1', name: 'Sea Ox', cls: 'tanker', lat: 51.9505, lon: 4.0605, hdg: 10, spd: 0, state: 'moored' }, { id: 'ai2', cls: 'feeder', lat: 51.9502, lon: 4.0601, spd: 12, state: 'underway' }] },
    liveAis: { near: () => [{ id: 'ais1', name: 'MAERSK X', cls: 'boxship', lat: 51.9499, lon: 4.0599, hdg: 78, sog: 0, state: 'moored', length: 366, beam: 51 }] },
  };
  const occ = collectOccupants(game, 51.95, 4.06, 3000, me);
  assert.deepEqual(occ.map((o) => o.kind).sort(), ['ai', 'ais', 'fleet', 'player']);
  assert.equal(occ.find((o) => o.kind === 'ais').len, 366);
  assert.ok(!occ.some((o) => o.id === 'me' || o.id === 'v-me'));
  assert.equal(occ.filter((o) => o.name === 'Anna').length, 1, 'a skipper\'s ship counted once');
  assert.deepEqual(collectOccupants({}, 0, 0, 1000, null), []);
});

test('ship classes the rules rely on exist', () => {
  for (const c of ['boxship', 'feeder', 'coaster', 'sloop']) assert.ok(SHIP_CLASSES[c]?.length && SHIP_CLASSES[c]?.draft && SHIP_CLASSES[c]?.beam);
});
