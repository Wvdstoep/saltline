// docs/BRIDGES-LOCKS-VHF-CONTRACT.md §3.3–§3.5, §8.2 — the shipped FIS registry, pack format, joins, statics / deltas / stations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadFis, unpackFis, packFis, subsetFis, encodeLine, decodeLine, FIS_FILE } from '../server/fis.js';
import { createWaterworks } from '../server/waterworks.js';
import { normalise, hoursOf, cemtOf, parseWkt, MOV_OF_TYPE } from '../scripts/fetch-fis.mjs';

const probe = JSON.parse(fs.readFileSync(new URL('./fixtures/ww/fis-probe.json', import.meta.url), 'utf8'));

test('shipped nl-fis.json.gz: geogeneration 4951, CC0 attribution, ≥ 3,000 bridges, ≥ 300 locks, sections and harbours', () => {
  assert.ok(fs.statSync(FIS_FILE).size < 5 * 1024 * 1024);
  const d = loadFis();
  assert.equal(d.geogeneration, 4951); assert.match(d.attribution, /Rijkswaterstaat.*CC0/); assert.equal(d.licence, 'CC0 1.0');
  assert.ok(d.bridges.length >= 3000, String(d.bridges.length)); assert.ok(d.locks.length >= 300); assert.ok(d.sections.length >= 5000); assert.ok(d.harbours.length >= 900);
  const ids = new Set(d.bridges.map((b) => b.id)); assert.equal(ids.size, d.bridges.length);
  for (const b of d.bridges.slice(0, 500)) {
    assert.ok(b.spans.length >= 1); assert.ok(b.line.length === 2);
    for (const s of b.spans) { assert.ok(s.b > s.a); assert.ok(Number.isFinite(s.clr)); }
    for (let i = 0; i < b.spans.length; i++) for (let j = i + 1; j < b.spans.length; j++) assert.ok(b.spans[i].b <= b.spans[j].a + 1e-6 || b.spans[j].b <= b.spans[i].a + 1e-6, `${b.name} spans overlap`);
  }
  const roz = d.locks.find((l) => l.name === 'Rozenburgsesluis');
  assert.deepEqual([roz.chambers[0].len, roz.chambers[0].wid], [305, 24]);
});

test('normaliser on the recorded probe records reproduces the game objects (field names of FIS v1.4)', () => {
  const raw = { meta: { gen: 4951, fetchedAt: '2026-10-09T12:42:52Z' }, ...probe, operatingtimes: [], section: [], maximumdimensions: [], touristharbour: [], administration: [{ Id: 19454, Name: 'Havenbedrijf Rotterdam nv', Type: 'HBDR' }, { Id: 7617569, Name: 'Rijkswaterstaat West-Nederland Zuid', Type: 'RWS' }] };
  const lockGeo = 'POLYGON ((4.22858 51.89417, 4.22833 51.89444, 4.22816 51.89439, 4.22873 51.8924, 4.22899 51.89147, 4.22922 51.89127, 4.2294 51.89139, 4.22916 51.89224, 4.22862 51.89404, 4.22858 51.89417))';
  raw.lock = raw.lock.map((l) => ({ ...l, Geometry: lockGeo }));
  raw.chamber = raw.chamber.map((c) => ({ ...c, Geometry: lockGeo }));
  const d = normalise(raw, { date: new Date('2026-10-09T12:00:00Z') });
  const botlek = d.bridges.find((b) => b.name === 'Botlekbrug');
  assert.deepEqual(botlek.spans.map((s) => [s.mov, s.clr, s.clrO, s.w]), [['lift', 14.04, 45, 87.3], ['lift', 14.06, 45, 75]]);
  assert.equal(botlek.vhf, 18); assert.equal(botlek.datum, 'NAP'); assert.equal(botlek.operator, 'RWS'); assert.equal(botlek.remote, true);
  const head = d.bridges.find((b) => b.name === 'Brug over buitenhoofd Rozenburgsesluis');
  assert.equal(head.spans[0].mov, 'bascule'); assert.equal(head.spans[0].clrO, 999); assert.equal(head.lockId, 'fis:4199'); assert.equal(head.head, 0);
  assert.equal(head.pairedWith, 'fis:7951');
  const rail = d.bridges.find((b) => b.name === 'Havenspoorlijn over Rozenburgsesluis');
  assert.equal(rail.spans[0].mov, 'fixed'); assert.equal(rail.spans[0].clr, 14); assert.equal(rail.lockId, null);
  const lock = d.locks[0];
  assert.equal(lock.chambers[0].len, 305); assert.equal(lock.chambers[0].sillDn, 6.5); assert.equal(lock.vhf, 22); assert.equal(lock.operator, 'Port of Rotterdam');
  assert.ok(lock.chambers[0].axis);
  // pack → unpack keeps the numbers
  const u = unpackFis(packFis(d));
  assert.deepEqual(u.bridges.find((b) => b.name === 'Botlekbrug').spans.map((s) => s.clr), [14.04, 14.06]);
  assert.equal(u.bridges.find((b) => b.id === 'fis:57361').spans[0].clrO, Infinity);
});

test('operating times: weekday 06–22 with BERP small-craft blocks, VERZ night window, ¼-past slots', () => {
  const ot = { Id: 1, SignInPeriod: null, Note: '', NormalSchedules: [{ From: '--01-01', Note: 'Bediening vindt plaats kwart voor en kwart over het hele uur',
    Mon: { OperatingTimes: [{ FromTime: '06:00', ToTime: '06:30' }, { FromTime: '06:30', ToTime: '09:30', Recommendation: 'BERP' }, { FromTime: '09:30', ToTime: '22:00' }, { FromTime: '22:00', ToTime: '00:00', Recommendation: 'VERZ' }, { FromTime: '00:00', ToTime: '06:00', Recommendation: 'VERZ' }] },
    Tue: { OperatingTimes: [] }, Wed: { OperatingTimes: [] }, Thu: { OperatingTimes: [] }, Fri: { OperatingTimes: [] }, Sat: { OperatingTimes: [{ FromTime: '00:00', ToTime: '23:59' }] }, Sun: { OperatingTimes: [] } }] };
  const h = hoursOf(ot, new Date('2026-10-09T00:00:00Z'));
  assert.deepEqual(h.hours.week[0], [['06:00', '22:00']]); assert.deepEqual(h.hours.week[5], [['00:00', '24:00']]);
  assert.deepEqual(h.blocks, [{ days: [1], from: '06:30', to: '09:30', why: 'commercial traffic only', only: 'small' }]);
  assert.deepEqual(h.hours.onRequestNight, { from: '22:00', to: '06:00', noticeMin: 60 });
  assert.deepEqual(h.slots, { every: 30, at: 15 });
});

test('helpers: WKT, CEMT from max dimensions, opening type table, polyline codec', () => {
  assert.deepEqual(parseWkt('POINT (4.33114528656006 51.8712826454111)').pts, [[51.87128, 4.33115]]);
  assert.equal(cemtOf(110, 12, 2.7), 'IV'); assert.equal(cemtOf(193, 11.4, 4), 'Vb'); assert.equal(cemtOf(110, 11.45, 3.5), 'Va'); assert.equal(cemtOf(15, 5, null), '0');
  assert.equal(MOV_OF_TYPE.HEF, 'lift'); assert.equal(MOV_OF_TYPE.BC, 'bascule'); assert.equal(MOV_OF_TYPE.DR, 'swing'); assert.equal(MOV_OF_TYPE.VST, 'fixed');
  const pts = [[51.87128, 4.33115], [51.9013, 4.22752], [51.89273, 4.22881]];
  assert.deepEqual(decodeLine(encodeLine(pts)), pts);
});

test('statics, state deltas and VHF stations around Botlek', () => {
  const d = loadFis();
  const ww = createWaterworks(null, subsetFis(d, [51.80, 4.0, 52.0, 4.5]), { now: () => 1_791_500_000 });
  const st = ww.statics(51.8713, 4.3311, 3000);
  const b = st.find((o) => o.name === 'Botlekbrug');
  assert.ok(b); assert.equal(b.t, 'bridge'); assert.ok(st.every((o) => Number.isFinite(o.spans ? o.spans[0].clr : 0)));
  assert.ok(JSON.stringify(st).length > 0 && !JSON.stringify(st).includes('null,null,null,null'));
  const s = ww.state(b.id); assert.equal(s.st, 'closed'); assert.deepEqual(s.sig[0].lights, ['red']);
  const ch18 = ww.stationsOn(18, 51.87, 4.33);
  assert.ok(ch18.some((x) => x.callName === 'Botlekbrug' && x.ch === 18 && x.h === 15));
  assert.ok(!ww.stationsOn(16, 51.87, 4.33).some((x) => x.callName === 'Botlekbrug'));
  const ch22 = ww.stationsOn(22, 51.90, 4.23).map((x) => x.callName);
  assert.ok(ch22.includes('Calandbrug Rozenburg') && ch22.includes('Rozenburgsesluis'));
  assert.ok(!ch22.some((n) => /buitenhoofd/.test(n)), 'lock-head bridges answer through the lock');
  const lk = ww.state('fis:4199'); assert.equal(lk.chambers.length, 1);
});

test('join (§3.5): a FIS bridge takes the nearest OSM line ≤ 60 m; unmatched OSM lines become e:2 / seamark objects', () => {
  const d = loadFis();
  const ww = createWaterworks(null, { bridges: d.bridges.filter((b) => b.name === 'Botlekbrug'), locks: [] }, { now: () => 0 });
  const osmLine = { id: 'osm:w24350815', kind: 'mixed', structure: 'truss', pts: [[51.8705, 4.3275], [51.8712, 4.3311], [51.8720, 4.3350]] };
  const far = { id: 'ofm:14/8392/5391:3', kind: 'road', cls: 'secondary', waterW: 20, pts: [[51.95, 4.10], [51.9502, 4.1004]] };
  const sm = { id: 'osm:n1', kind: 'road', pts: [[51.96, 4.20], [51.9602, 4.2006]], tags: { 'seamark:bridge:category': 'lifting', 'seamark:bridge:clearance_height_closed': '3.6', 'seamark:bridge:clearance_height_open': '24.0', 'seamark:bridge:clearance_width': '24.0' } };
  assert.deepEqual(ww.joinLines([osmLine, far, sm]), { joined: 1, added: 2 });
  const b = ww.get('fis:17838816');
  assert.equal(b.lineSrc, 'osm'); assert.equal(b.structure, 'truss'); assert.equal(b.kind, 'mixed'); assert.equal(b.spans[0].clr, 14.04);
  assert.ok(b.spans[0].a >= 0 && b.spans[1].b <= 700);
  assert.equal(ww.get('ofm:14/8392/5391:3').e, 2); assert.equal(ww.get('ofm:14/8392/5391:3').spans[0].clr, 2.5);
  const o = ww.get('osm:n1'); assert.equal(o.e, 1); assert.equal(o.spans[0].mov, 'lift'); assert.equal(o.spans[0].clrO, 24);
});

test('save / load: strike outages survive a restart; SALTLINE_WW_OFF=1 loads nothing', () => {
  let T = 100;
  const br = { id: 'x', name: 'x', p: [52, 5], line: [[52, 4.999], [52, 5.001]], datum: 'NAP', spans: [{ id: 0, a: 10, b: 50, mov: 'fixed', clr: 5, clrO: null, w: 40, rec: 1 }], blocks: [] };
  const a = createWaterworks(null, { bridges: [br], locks: [] }, { now: () => T });
  a.setOut('x', T + 600, 'bridge strike');
  const saved = JSON.parse(JSON.stringify(a.toSave()));
  const b = createWaterworks(null, { bridges: [br], locks: [] }, { now: () => T + 10 });
  b.load(saved); assert.equal(b.state('x').out.until, T + 600);
  const prev = process.env.SALTLINE_WW_OFF; process.env.SALTLINE_WW_OFF = '1';
  try { assert.equal(loadFis(FIS_FILE + '.none'), null); } finally { if (prev === undefined) delete process.env.SALTLINE_WW_OFF; else process.env.SALTLINE_WW_OFF = prev; }
});
