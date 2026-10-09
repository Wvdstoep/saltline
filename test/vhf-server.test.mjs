// Server radio (server/vhf.js) against a stub `ww` with the lane A interface (§9.5) — routing, responders, timing,
// wrong channel / out of hours, VTS redirect, dual watch, AI vs AIS ships, DSC distress (§10.6.3–8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRadio, loadVts, coastStationsFrom, loadVtsFile } from '../server/vhf.js';
import { render } from '../shared/vhfphrases.js';
import { T0, NIGHT, makeWw, makeGame, player, run, vhfOf, ROZ_LOCK } from './vhf-helpers.mjs';

const VTS = JSON.parse(fs.readFileSync(new URL('../server/vhfdata/vts-nl.json', import.meta.url), 'utf8'));
const HARBORS = [{ id: 'rotterdam', country: 'NL', lat: 51.98, lon: 4.03 }, { id: 'ijmuiden', country: 'NL', lat: 52.465, lon: 4.555 }, { id: 'vlissingen', country: 'NL', lat: 51.447, lon: 3.598 }];

function setup({ t = T0, players = [], traffic = [], ais = [], inland = false } = {}) {
  const clock = { t };
  const now = () => clock.t;
  const ww = makeWw({ now });
  const game = makeGame(players, { traffic });
  const radio = createRadio(game, ww, { now, vts: VTS, harbors: HARBORS, aisNear: () => ais, isInland: () => inland });
  return { clock, ww, game, radio };
}
const near = (lat, lon, dLat = 0.01) => [lat - dLat, lon];

test('§10.6.3 wrong channel: a call to Botlekbrug on 16 → no station reply, tip after 2 tries', () => {
  const p = player('p1', 'Saltwind', 51.85, 4.34);
  const { radio, clock, ww } = setup({ players: [p] });
  radio.set(p, { ch: 16 });
  let r = radio.tx(p, { to: 'Botlekbrug', phrase: 'req_open' });
  assert.deepEqual([r.ok, r.answered, r.why], [true, false, 'channel']);
  run(radio, clock, 10);
  assert.equal(vhfOf(p).filter((m) => !m.self).length, 0);
  assert.equal(ww.calls.request.length, 0);
  assert.equal(p.events.length, 0);
  clock.t += 3000;
  radio.tx(p, { to: 'Botlekbrug', phrase: 'req_open' });
  run(radio, clock, 10);
  assert.equal(vhfOf(p).filter((m) => !m.self).length, 0);
  assert.equal(p.events.length, 1);
  assert.match(p.events[0].text, /No answer from Botlekbrug on channel 16\. Botlekbrug works channel 18\./);
});

test('§10.6.3 correct channel → reply in 3–8 s with n and in (Rozenburgsesluis lift bridge, sloop 17 m)', () => {
  const p = player('p1', 'Saltwind', ...near(51.8905, 4.2270), { hdg: 5, spd: 4 });
  const { radio, clock, ww } = setup({ players: [p] });
  radio.set(p, { ch: 68 });
  const r = radio.tx(p, { to: 'fis:rzs', phrase: 'req_open' });
  assert.deepEqual([r.ok, r.answered], [true, true]);
  assert.equal(ww.calls.request.length, 1);
  assert.equal(ww.calls.request[0].id, 'fis:rzs-b2');                 // the lock-head bridge on the ship's side
  assert.equal(ww.calls.request[0].ship.ad, 17.0);
  assert.ok(ww.calls.request[0].eta >= 60);
  const echo = vhfOf(p)[0];
  assert.equal(echo.self, true);
  assert.equal(render(echo.phrase, echo.args, 'en'), 'Rozenburgsesluis, this is Saltwind, northbound on the approach, air draught 17.0 metres, request bridge opening, over.');
  run(radio, clock, 2.9);
  assert.equal(vhfOf(p).length, 1, 'no answer before 3 s');
  run(radio, clock, 5.2);
  const rep = vhfOf(p).find((m) => !m.self);
  assert.ok(rep, 'answer within 8 s');
  assert.equal(rep.phrase, 'op_br_wait');
  assert.deepEqual([rep.args.n, rep.args.in, rep.args.hhmm, rep.from.kind, rep.from.name, rep.ch], [1, 4, '14:24', 'lock', 'Rozenburgsesluis', 68]);
  assert.ok(rep.q > 0.9);
  assert.equal(render(rep.phrase, rep.args, 'en'), 'Saltwind, Rozenburgsesluis. Next opening in 4 minutes at 14:24, you are number 1. Wait at the waiting berth, over.');
  // the bridge opens: the ww state machine announces it on the lock's channel
  ww.emit('opening', { id: 'fis:rzs', ships: ['p1'] });
  run(radio, clock, 2);
  const op = vhfOf(p).filter((m) => m.phrase === 'op_br_opening');
  assert.equal(op.length, 1);
  assert.equal(render(op[0].phrase, op[0].args, 'nl'), 'Saltwind, Rozenburgsesluis, de brug gaat open, doorvaren op groen.');
});

test('bridge verdicts: fits → "pass under" with clearance; too high → "will not pass"', () => {
  const low = player('p1', 'Cruiser', 51.856, 4.33, { ad: 3.0 });
  const tall = player('p2', 'Schooner', 51.857, 4.33, { ad: 46.0 });
  const { radio, clock } = setup({ players: [low, tall] });
  for (const p of [low, tall]) { radio.set(p, { ch: 18 }); radio.tx(p, { to: 'Botlekbrug', phrase: 'req_open' }); }
  run(radio, clock, 9);
  const a = vhfOf(low).find((m) => m.to?.id === 'p1' && !m.self), b = vhfOf(tall).find((m) => m.to?.id === 'p2' && !m.self);
  assert.equal(a.phrase, 'op_br_under');
  assert.match(render(a.phrase, a.args, 'en'), /Clearance is 14\.0 metres now, you can pass under\./);
  assert.equal(b.phrase, 'op_br_never');
  assert.match(render(b.phrase, b.args, 'en'), /Open clearance is 45\.0 metres, you will not pass/);
  // the other skipper on 18 hears both answers (same net)
  assert.ok(vhfOf(low).some((m) => m.to?.id === 'p2'));
});

test('out of hours: no answer (realistic), tip with the hours after 2 unanswered calls', () => {
  const p = player('p1', 'Saltwind', 51.869, 4.30);
  const { radio, clock, ww } = setup({ t: NIGHT, players: [p] });
  radio.set(p, { ch: 20 });
  assert.equal(radio.tx(p, { to: 'Testbrug', phrase: 'req_open' }).why, 'hours');
  clock.t += 2500;
  radio.tx(p, { to: 'Testbrug', phrase: 'req_open' });
  run(radio, clock, 10);
  assert.equal(vhfOf(p).filter((m) => !m.self).length, 0);
  assert.equal(ww.calls.request.length, 0);
  assert.match(p.events.at(-1).text, /Testbrug: out of service hours \(06:00–22:00\)\. Service resumes 06:00\./);
  const st = radio.stationsFor(p);
  assert.deepEqual(st.stations.filter((s) => s.id === 'fis:testbrug').map((s) => [s.silent, s.why]), [[true, 'out of hours until 06:00']]);
});

test('§10.6.4 VTS redirect: a report to Oude Maas (62) from inside the Maasbruggen polygon → "call on channel 81"', () => {
  const p = player('p1', 'Saltwind', 51.910, 4.49, { ad: 15, hdg: 90 });
  const { radio, clock } = setup({ players: [p] });
  radio.set(p, { ch: 62 });
  radio.tx(p, { to: 'Oude Maas', phrase: 'vts_report', args: { dest: 'Dordrecht' } });
  run(radio, clock, 9);
  const rep = vhfOf(p).find((m) => !m.self);
  assert.equal(rep.phrase, 'op_vts_redirect');
  assert.equal(render(rep.phrase, rep.args, 'en'), 'Saltwind, Oude Maas. You are in sector Maasbruggen, call on channel 81.');
  // on 81 Maasbruggen takes the report and names the traffic within 3 km (players, AI, AIS names)
  clock.t += 3000;
  radio.set(p, { ch: 81 });
  radio.tx(p, { to: 'Maasbruggen', phrase: 'vts_report', args: { dest: 'Dordrecht' } });
  run(radio, clock, 9);
  const ack = vhfOf(p).filter((m) => !m.self).at(-1);
  assert.equal(ack.phrase, 'op_vts_ack');
  assert.equal(ack.from.kind, 'vts');
});

test('VTS: unverified sector polygons are not stations; a ship inside one belongs to the nearest verified sector', () => {
  const v = loadVts(VTS);
  assert.deepEqual(v.sectors.map((s) => s.ch).sort((a, b) => a - b), [1, 11, 14, 62, 81]);
  assert.ok(v.unverified.every((u) => u.fallback));
  const { radio } = setup();
  assert.equal(radio.sectorAt([51.8905, 4.2270]).id, 'vts:oude-maas');      // Rozenburg (unverified) → nearest verified
  assert.equal(radio.sectorAt([52.05, 3.8]).id, 'vts:maas-approach');
  assert.equal(radio.sectorAt([53.5, 5.0]), null);
});

test('loadVtsFile prefers the verified radio seed (server/vhfdata/vts-nl.json), falls back to lane A', async () => {
  const v = await loadVtsFile();
  assert.ok(v.sectors.length >= 5);
});

test('§10.6.5 dual watch: a receiver on 18 with DW gets ch 16 transmissions; without DW does not', () => {
  const a = player('a', 'Alpha', 51.9, 4.2), b = player('b', 'Bravo', 51.91, 4.2), c = player('c', 'Charlie', 51.92, 4.2);
  const { radio } = setup({ players: [a, b, c] });
  radio.set(a, { ch: 16 }); radio.set(b, { ch: 18, dual: true }); radio.set(c, { ch: 18, dual: false });
  radio.tx(a, { phrase: 'securite', args: { nature: 'danger' } });
  assert.equal(vhfOf(b).length, 1);
  assert.equal(vhfOf(b)[0].ch, 16);
  assert.equal(vhfOf(c).length, 0);
});

test('range: a player beyond range does not hear; near the edge the message arrives with low q (client garbles)', () => {
  const a = player('a', 'Alpha', 51.9, 4.2, { ad: 7.5 }), far = player('f', 'Far', 52.3, 4.2, { ad: 7.5 }), edge = player('e', 'Edge', 51.9 + 21.5 / 111.2, 4.2, { ad: 7.5 });
  const { radio } = setup({ players: [a, far, edge] });
  for (const p of [a, far, edge]) radio.set(p, { ch: 72 });
  radio.tx(a, { phrase: 'call', to: 'Edge' });
  assert.equal(vhfOf(far).length, 0);                                     // 44 km > 22.6 km
  const m = vhfOf(edge)[0];
  assert.ok(m && m.q > 0 && m.q < 0.15, `q ${m?.q}`);
  assert.deepEqual(m.to, { id: 'e', name: 'Edge' });
});

test('inland 1 W: two coasters on 10 hear each other at 7 km, not at 9 km (§10.6.1)', () => {
  const a = player('a', 'A', 51.9, 4.5, { ad: 7.5 }), b = player('b', 'B', 51.9 + 7 / 111.2, 4.5, { ad: 7.5 }), c = player('c', 'C', 51.9 - 9 / 111.2, 4.5, { ad: 7.5 });
  const { radio } = setup({ players: [a, b, c], inland: true });
  for (const p of [a, b, c]) radio.set(p, { ch: 10 });
  assert.equal(radio.youFields(a).powerEff, 'lo');
  radio.tx(a, { phrase: 'call' });
  assert.equal(vhfOf(b).length, 1);
  assert.equal(vhfOf(c).length, 0);
});

test('§10.6.7 AI ships answer passing calls; AIS ships never appear as senders', () => {
  const p = player('p1', 'Saltwind', 51.95, 3.9, { ad: 17 });
  const traffic = [{ id: 'ai3', name: 'Nordic Star', lat: 51.96, lon: 3.91, hdg: 200 }, { id: 'ais:244123456', ais: true, name: 'REAL VESSEL', lat: 51.955, lon: 3.905 }];
  const ais = [{ mmsi: 244123456, name: 'REAL VESSEL', lat: 51.955, lon: 3.905 }];
  const { radio, clock } = setup({ players: [p], traffic, ais });
  radio.set(p, { ch: 13 });
  radio.tx(p, { to: 'Nordic Star', phrase: 'pass_port' });
  clock.t += 2500;
  radio.tx(p, { to: 'REAL VESSEL', phrase: 'pass_port' });
  run(radio, clock, 10);
  const got = vhfOf(p).filter((m) => !m.self);
  assert.equal(got.length, 1);
  assert.equal(got[0].phrase, 'ai_pass_port');
  assert.equal(render(got[0].phrase, got[0].args, 'en'), 'Saltwind, Nordic Star. Port to port, agreed. Nordic Star out.');
  assert.ok(vhfOf(p).every((m) => !String(m.from.id).startsWith('ais')));
  assert.ok(!radio.stationsFor(p).stations.some((s) => /REAL VESSEL/.test(s.name)));
  // an AI ship called on 16 asks to switch to 13 (sea)
  clock.t += 2500;
  radio.set(p, { ch: 16 });
  radio.tx(p, { to: 'Nordic Star', phrase: 'call' });
  run(radio, clock, 9);
  assert.equal(vhfOf(p).filter((m) => !m.self).at(-1).phrase, 'ai_switch');
  assert.equal(vhfOf(p).filter((m) => !m.self).at(-1).args.y, 13);
});

test('coast guard: a non-distress call on 16 → "switch to channel 67"; on 67 → "go ahead"', () => {
  const p = player('p1', 'Saltwind', 51.99, 4.0);
  const { radio, clock } = setup({ players: [p] });
  radio.set(p, { ch: 16 });
  radio.tx(p, { to: 'Netherlands Coastguard', phrase: 'call' });
  run(radio, clock, 9);
  let last = vhfOf(p).filter((m) => !m.self).at(-1);
  assert.deepEqual([last.phrase, last.args.y, last.from.kind], ['op_cg_switch', 67, 'cg']);
  clock.t += 2500;
  radio.set(p, { ch: 67 });
  radio.tx(p, { to: 'Netherlands Coastguard', phrase: 'call' });
  run(radio, clock, 9);
  last = vhfOf(p).filter((m) => !m.self).at(-1);
  assert.equal(last.phrase, 'op_cg_goahead');
});

test('§10.6.8 DSC distress → coast guard reply on 16 + the sar_alert event + Mayday relay chat line', () => {
  const p = player('p1', 'Saltwind', 51.99, 4.0), q = player('p2', 'Bystander', 52.0, 4.05);
  const { radio, clock, game } = setup({ players: [p, q] });
  const alerts = [];
  radio.on('sar_alert', (a) => alerts.push(a));
  radio.set(q, { ch: 72, dual: false });
  const r = radio.dsc(p, { kind: 'distress', nature: 'fire' });
  assert.equal(r.ok, true);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].player, alerts[0].nature], ['p1', 'fire']);
  assert.match(game.chat[0].text, /^Mayday relay: Saltwind reports fire at 51\.99, 4\.00\. Netherlands Coastguard coordinating\.$/);
  assert.equal(vhfOf(q).filter((m) => m.ch === 70).length, 1, 'every powered set decodes the DSC alert');
  run(radio, clock, 9);
  const rep = vhfOf(p).find((m) => m.phrase === 'op_cg_mayday');
  assert.ok(rep);
  assert.equal(rep.ch, 16);
  assert.match(render(rep.phrase, rep.args, 'en'), /^MAYDAY Saltwind, this is Netherlands Coastguard, received MAYDAY\./);
  assert.equal(radio.dsc(p, { kind: 'distress' }).why, 'rate');
});

test('lock registration: queue answer with chamber, number and minutes; fee line when the lock charges', () => {
  const p = player('p1', 'Saltwind', 51.889, 4.227, { hdg: 0 });
  const { radio, clock, ww } = setup({ players: [p] });
  radio.set(p, { ch: 68 });
  radio.tx(p, { to: 'Rozenburgsesluis', phrase: 'req_lock' });
  run(radio, clock, 9);
  assert.equal(ww.calls.registerLock.length, 1);
  const rep = vhfOf(p).find((m) => m.phrase === 'op_lk_queue');
  assert.deepEqual([rep.args.n, rep.args.chamber, rep.args.in], [1, 'A', 9]);
  assert.ok(!vhfOf(p).some((m) => m.phrase === 'op_lk_fee'), 'Port of Rotterdam lock: no fee');
  ww.emit('levelling', { id: 'fis:rzs', dh: 1.0, dur: 258 });
  run(radio, clock, 2);
  assert.equal(render(vhfOf(p).at(-1).phrase, vhfOf(p).at(-1).args, 'en'), 'Rozenburgsesluis, levelling, 1.00 metres, about 4 minutes.');
});

test('rate limits, free text, phrase whitelist, DSC-only channel', () => {
  const a = player('a', 'Alpha', 51.9, 4.2), b = player('b', 'Bravo', 51.91, 4.2);
  const { radio, clock } = setup({ players: [a, b] });
  radio.set(a, { ch: 72 }); radio.set(b, { ch: 72 });
  assert.equal(radio.tx(a, { text: 'Bravo, meet you at the lock?' }).ok, true);
  clock.t += 3000;
  assert.equal(radio.tx(a, { text: 'again' }).why, 'rate');                  // free text: 1 per 4 s
  clock.t += 1500;
  assert.equal(radio.tx(a, { text: 'x'.repeat(300) }).ok, true);
  assert.equal(vhfOf(b).at(-1).text.length, 120);
  clock.t += 4000;
  assert.equal(radio.tx(a, { phrase: 'op_br_wait' }).why, 'phrase');          // players cannot speak for operators
  clock.t += 2000;
  assert.equal(radio.tx(a, { phrase: 'call', ch: 70 }).why, 'channel');
  radio.set(a, { ch: 70 });
  assert.equal(a.radio.ch, 72);
  assert.equal(radio.tx({ ...a, radio: { ...a.radio, on: false } }, { phrase: 'call' }).why, 'off');
});

test('stationsFor: stations on the tuned channel with signal bars + context rows for bridges/locks within 3 km', () => {
  const p = player('p1', 'Saltwind', 51.885, 4.227);
  const { radio, game } = setup({ players: [p] });
  radio.set(p, { ch: 16, open: true });
  const st = radio.stationsFor(p);
  assert.ok(st.stations.some((s) => s.kind === 'cg'));
  assert.deepEqual(st.near.map((n) => [n.name, n.ch, n.kind]), [['Rozenburgsesluis', 68, 'lock']]);
  assert.equal(st.sector.name, 'Oude Maas');
  const pushed = p.inbox.filter((m) => m.t === 'vhf_st');
  assert.equal(pushed.length, 1, 'opening the set pushes the list');
  assert.ok(game);
});

test('coast stations: one per ~60 km, "<country> Coastguard"', () => {
  const c = coastStationsFrom([...HARBORS, { id: 'zz', country: 'NL', lat: 51.99, lon: 4.05 }, { id: 'dover', country: 'GB', lat: 51.12, lon: 1.32 }]);
  assert.equal(c.length, 4);
  assert.ok(c.some((s) => s.name === 'Netherlands Coastguard'));
  assert.ok(c.some((s) => s.name === 'United Kingdom Coastguard'));
});

test('onAction routes vhf_set / vhf_tx / dsc and leaves other actions alone', () => {
  const p = player('p1', 'Saltwind', 51.9, 4.2);
  const { radio } = setup({ players: [p] });
  assert.equal(radio.onAction(p, { action: 'vhf_set', ch: 13 }), true);
  assert.equal(p.radio.ch, 13);
  assert.equal(radio.onAction(p, { action: 'vhf_tx', phrase: 'radio_check' }), true);
  assert.equal(radio.onAction(p, { action: 'dock' }), false);
  assert.equal(ROZ_LOCK.ch, 68);
});
