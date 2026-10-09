// docs/BRIDGES-LOCKS-VHF-CONTRACT.md §10.4 — inland graph and planner: air draught routing, staande-mastroute, the
// Rozenburg schooner case on the recorded FIS subgraph, tide windows, the sea-gate join; §4.1 pounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { unpackFis } from '../server/fis.js';
import { buildGraph, planInland, whyNot, joinSeaGates, planWithSea, distM } from '../server/inland.js';
import { airDraftNow, profileOf } from '../shared/airdraft.js';
import { waterLevelAt } from '../shared/waterlevel.js';

const rd = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
const rtm = unpackFis(rd('./fixtures/ww/fis-rotterdam.json'));
const GATES = rd('../server/waterworks/seagates-nl.json').gates;
const LEVELS = rd('../server/waterworks/levels-nl.json');
const T0 = Date.UTC(2026, 9, 14, 10, 0) / 1000;    // Wed 12:00 Amsterdam
const ship = (cls, st = {}) => { const p = profileOf(cls), a = airDraftNow(cls, st); return { L: p.length, B: p.beam, beam: p.beam, T: a.T, need: a.need(0), sail: p.sail, kn: 8, kind: p.sail ? 'small' : 'commercial' }; };
const span = (mov, clr, w = 30) => ({ id: 0, a: 10, b: 10 + w, mov, clr, clrO: mov === 'fixed' ? null : Infinity, w, rec: 1 });
const bridge = (id, p, mov, clr, extra = {}) => ({ id, name: id, p, datum: 'KP', kp: 0, spans: [span(mov, clr)], vhf: 18, call: 'vhf', hours: null, blocks: [], slots: null, ...extra });
const sec = (id, pts) => ({ id, pts });

test('1. coaster in ballast takes the short path under the fixed 9.0 m; laden with 2 tiers it takes the bascule (opening, wait ≥ 12 min)', () => {
  const A = [52.0, 5.0], M = [52.0, 5.05], B = [52.0, 5.1], N = [52.03, 5.05];
  const g = buildGraph({ sections: [sec(1, [A, M]), sec(2, [M, B]), sec(3, [A, N]), sec(4, [N, B])],
    bridges: [bridge('fixed9', [52.0, 5.03], 'fixed', 9.0), bridge('bascule', [52.018, 5.03], 'bascule', 2.0, { slots: { every: 24, at: 0 } })] });
  const ballast = planInland(g, A, B, ship('coaster', { ballastT: 600, fold: { wheelhouse: 1 } }), T0);
  assert.ok(ballast); assert.deepEqual(ballast.marks.map((m) => [m.id, m.action]), [['fixed9', 'under']]);
  const laden = planInland(g, A, B, ship('coaster', { cargo: { containers: 720 }, fold: { wheelhouse: 1 } }), T0);
  assert.ok(laden); const m = laden.marks.find((x) => x.id === 'bascule');
  assert.equal(m.action, 'opening'); assert.ok(m.waitMin >= 12, String(m.waitMin)); assert.equal(m.vhf, 18);
  assert.ok(!laden.marks.some((x) => x.id === 'fixed9'));
  assert.ok(laden.eta > ballast.eta);
  assert.deepEqual(laden.points[0], A); assert.deepEqual(laden.points[laden.points.length - 1], B);
});

test('2. sailing yacht 17 m: only fixed bridges ≥ 17.3 m or movable ones → "Staande-mastroute" with ≥ 3 openings', () => {
  const P = (k) => [52.2, 5.0 + 0.01 * k];
  const sections = [], bridges = [];
  for (let k = 0; k < 6; k++) sections.push(sec(10 + k, [P(k), P(k + 1)]));
  sections.push(sec(30, [P(0), [52.19, 5.03]]), sec(31, [[52.19, 5.03], P(6)]));          // a shorter-looking bypass under a 12 m bridge
  bridges.push(bridge('b1', [52.2, 5.005], 'bascule', 1.5), bridge('b2', [52.2, 5.025], 'swing', 1.0), bridge('b3', [52.2, 5.045], 'lift', 3.0, {}),
    bridge('f25', [52.2, 5.055], 'fixed', 25), bridge('f12', [52.19333, 5.02], 'fixed', 12));
  bridges[2].spans[0].clrO = 30;
  const g = buildGraph({ sections, bridges });
  const r = planInland(g, P(0), P(6), ship('sloop'), T0);
  assert.ok(r); assert.equal(r.label, 'Staande-mastroute');
  assert.ok(!r.marks.some((m) => m.id === 'f12'));
  for (const mk of r.marks.filter((m) => m.kind === 'bridge' && m.action === 'under')) assert.ok(mk.clr >= 17.3, mk.id);
  assert.equal(r.marks.filter((m) => m.action === 'opening').length, 3);
  assert.ok(r.warnings.some((w) => w.kind === 'standing_mast'));
});

test('3. Rozenburg (recorded FIS subgraph): the schooner avoids the Rozenburgsesluis and goes via the Calandbrug; the coaster locks through', () => {
  const g = buildGraph(rtm);
  const calandkanaal = [51.8968, 4.2299], hartelkanaal = [51.889, 4.232];
  const sch = planInland(g, calandkanaal, hartelkanaal, ship('schooner'), T0);
  assert.ok(sch, 'a route exists');
  const names = sch.marks.map((m) => m.name);
  assert.ok(names.includes('Calandbrug Rozenburg'), names.join(', '));
  assert.equal(sch.marks.find((m) => m.name === 'Calandbrug Rozenburg').action, 'opening');
  assert.ok(!names.some((n) => /Rozenburgsesluis/.test(n)), names.join(', '));
  // the direct way is blocked by the fixed rail bridge over the lock (NAP +14.0), not by the head bridges (bascules)
  const why = whyNot(g, calandkanaal, hartelkanaal, ship('schooner'), T0).map((x) => x.name);
  assert.ok(why.includes('Havenspoorlijn over Rozenburgsesluis'), why.join(', '));
  assert.ok(!why.some((n) => /hoofd Rozenburgsesluis/.test(n)));
  const co = planInland(g, calandkanaal, hartelkanaal, ship('coaster', { fold: { wheelhouse: 1 } }), T0);
  assert.ok(co.marks.some((m) => m.name === 'Rozenburgsesluis' && m.action === 'lock' && m.vhf === 22));
  assert.ok(co.distM < 5000 && sch.distM > 20000);
});

test('4. tide window: a fixed bridge passable only below +0.5 m → second pass with a window mark', () => {
  const A = [51.90, 4.28], B = [51.90, 4.32];
  const need = ship('coaster', { ballastT: 600, fold: { wheelhouse: 1 } }).need;
  const g = buildGraph({ sections: [sec(1, [A, B])], bridges: [{ ...bridge('tidal', [51.90, 4.30], 'fixed', need + 0.5), datum: 'NAP', kp: null, name: 'Spijkenisserbrug (test)' }] });
  const r = planInland(g, A, B, ship('coaster', { ballastT: 600, fold: { wheelhouse: 1 } }), T0);
  assert.ok(r); assert.equal(r.pass, 2);
  const m = r.marks.find((x) => x.id === 'tidal');
  assert.equal(m.tide, true); assert.ok(m.windowFrom >= T0 && m.windowTo > m.windowFrom);
  assert.ok(r.warnings.some((w) => w.kind === 'tide_window' && /between \d\d:\d\d and \d\d:\d\d \(low water\)/.test(w.text)));
  // a ship that also fits at MHWS needs no window
  assert.equal(planInland(g, A, B, { ...ship('cruiser'), need: 3 }, T0).pass, 1);
});

test('5. sea join: North Sea → IJsselmeer marina enters via IJmuiden or Den Oever and ends at the marina', () => {
  const ijm = [52.4640, 4.6200], ams = [52.3850, 4.9000], oranje = [52.3800, 4.9600], enk = [52.7020, 5.2900], dov = [52.9300, 5.0550];
  const g = buildGraph({ sections: [sec(1, [ijm, ams]), sec(2, [ams, oranje]), sec(3, [oranje, [52.55, 5.10], enk]), sec(4, [dov, [52.85, 5.15], enk])], bridges: [], locks: [] }, { levels: LEVELS });
  joinSeaGates(g, GATES);
  assert.ok(g.gates.some((x) => x.id === 'ijmuiden') && g.gates.some((x) => x.id === 'denoever'));
  const seaCalls = [];
  const seaPlan = (from, to) => { seaCalls.push([from, to]); return { points: [[from.lat, from.lon], [to.lat, to.lon]], distM: Math.round(distM([from.lat, from.lon], [to.lat, to.lon])), marks: [], warnings: [] }; };
  const north = [52.80, 4.40];
  const r = planWithSea(seaPlan, g, north, enk, ship('sloop'), T0, { toInland: true });
  assert.ok(r); assert.ok(['ijmuiden', 'denoever'].includes(r.gate), r.gate);
  assert.deepEqual(r.points[r.points.length - 1], enk);
  assert.ok(r.marks.some((m) => m.kind === 'sea_gate'));
  assert.ok(seaCalls.length >= 2 && seaCalls.length <= 3);
  // the marina is in the non-tidal IJsselmeer pound
  const w = waterLevelAt(enk[0], enk[1], T0, { levels: LEVELS });
  assert.equal(w.ref, 'canal'); assert.equal(w.h, -0.2);
  assert.equal(waterLevelAt(52.5, 5.2, Date.UTC(2026, 6, 1) / 1000, { levels: LEVELS }).h, -0.1);
  assert.equal(waterLevelAt(52.40, 4.80, T0, { levels: LEVELS }).h, -0.4);
  assert.equal(waterLevelAt(51.98, 4.05, T0, { levels: LEVELS }).ref, 'tidal');
});

test('edge limits: CEMT max dimensions refuse oversize ships', () => {
  const A = [52.0, 6.0], B = [52.0, 6.05];
  const g = buildGraph({ sections: [{ id: 1, pts: [A, B], lim: { L: 55, B: 6.6, T: 2.5, cemt: 'II' } }] });
  assert.equal(planInland(g, A, B, ship('coaster'), T0), null);
  assert.ok(planInland(g, A, B, ship('sloop'), T0));
  assert.equal(whyNot(g, A, B, ship('coaster'), T0)[0].why, 'draught');
});
