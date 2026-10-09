// Client radio formatting (public/js/vhffmt.js): log rows with garbling, chips, quick call, presets, previews, knob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chLabel, powerLabel, logEntry, previewText, phraseRows, chips, quickCall, stationRows, nextTarget, parseDigits, knobAngle, playSeconds, esc, barsText } from '../public/js/vhffmt.js';

const near = [{ id: 'fis:rzs', name: 'Rozenburgsesluis', kind: 'lock', ch: 68, distKm: 0.4 }, { id: 'fis:calandbrug', name: 'Calandbrug', kind: 'bridge', ch: 20, distKm: 1.2 }];

test('channel label and power label', () => {
  assert.deepEqual([chLabel(16).num, chLabel(16).name], ['16', 'Distress & calling']);
  assert.equal(chLabel(6).num, '06');
  assert.equal(chLabel(70).dsc, true);
  assert.equal(chLabel(99).name, 'Not a marine channel');
  assert.equal(powerLabel({ ch: 68, power: 'hi', inland: true }), '1 W (inland)');
  assert.equal(powerLabel({ ch: 16, power: 'hi', inland: true }), '25 W');
  assert.equal(powerLabel({ ch: 68, power: 'lo' }), '1 W');
});
test('log row: rendered in the receiver language, garbled under q 0.15, the own echo never garbled', () => {
  const m = { t: 'vhf', ch: 68, from: { id: 'fis:rzs', name: 'Rozenburgsesluis', kind: 'lock' }, to: { id: 'p1', name: 'Saltwind' }, phrase: 'op_br_opening', args: { ship: 'Saltwind', st: 'Rozenburgsesluis' }, q: 0.9, at: 1760012400000 };
  const e = logEntry(m, { lang: 'nl' });
  assert.equal(e.text, 'Saltwind, Rozenburgsesluis, de brug gaat open, doorvaren op groen.');
  assert.deepEqual([e.from, e.to, e.bars, e.op, e.garbled], ['Rozenburgsesluis', 'Saltwind', 4, true, false]);
  const g = logEntry({ ...m, q: 0.1 }, { lang: 'en' });
  assert.equal(g.garbled, true);
  assert.ok(g.text.includes('·'));
  assert.equal(g.text, logEntry({ ...m, q: 0.1 }, { lang: 'en' }).text);
  const own = logEntry({ ...m, from: { id: 'p1', name: 'Saltwind', kind: 'player' }, q: 0.05, self: true, phrase: 'say_again', args: {} });
  assert.deepEqual([own.text, own.self, own.garbled], ['Say again, over.', true, false]);
  assert.equal(logEntry({ ...m, ch: 70, dsc: 'distress', phrase: 'dsc_alert', args: { me: 'X', kind: 'distress', pos: [52, 4], nature: 'fire' } }).dsc, 'distress');
});
test('context chips: "Call Rozenburgsesluis (ch 68)" first, VTS sector, presets; hot when on another channel', () => {
  const c = chips({ near, sector: { id: 'vts:oude-maas', name: 'Oude Maas', ch: 62 }, ch: 16 });
  assert.deepEqual(c.slice(0, 3).map((x) => x.label), ['Call Rozenburgsesluis (ch 68)', 'Call Calandbrug (ch 20)', 'VTS Oude Maas (ch 62)']);
  assert.deepEqual([c[0].phrase, c[1].phrase, c[2].phrase], ['req_lock', 'req_open', 'vts_report']);
  assert.equal(c[0].hot, true);
  assert.equal(chips({ near, ch: 68 })[0].hot, false);
  assert.ok(c.some((x) => x.preset && x.ch === 16 && x.on));
  assert.equal(chips({ fallbackCh: 10, ch: 16 })[0].label, 'Port area: listen ch 10');
});
test('Shift+Z quick call → the nearest bridge or lock with its channel and phrase', () => {
  assert.deepEqual(quickCall(near), { ch: 68, to: { id: 'fis:rzs', name: 'Rozenburgsesluis', kind: 'lock' }, phrase: 'req_lock' });
  assert.equal(quickCall([]), null);
});
test('preview: the phrase filled with the ship numbers, or the free text', () => {
  const you = { name: 'Saltwind', ship: { hdg: 0, lat: 51.88, lon: 4.22 }, air: { ad: 17.04, T: 1.9 } };
  assert.equal(previewText({ phrase: 'req_open', target: { name: 'Rozenburgsesluis' }, you, lang: 'en' }), 'Rozenburgsesluis, this is Saltwind, northbound on the approach, air draught 17.0 metres, request bridge opening, over.');
  assert.equal(previewText({ phrase: 'call', you, lang: 'en' }), 'All stations, All stations, this is Saltwind, Saltwind, over.');
  assert.equal(previewText({ text: 'see you at the lock', phrase: 'call', you }), 'see you at the lock');
});
test('phrase rows: labels in the language, context-sorted', () => {
  assert.deepEqual(phraseRows({ near: { kind: 'bridge' } }, 'en').slice(0, 2).map((r) => r.label), ['Request opening', 'Call']);
  assert.equal(phraseRows({ target: { kind: 'lock' } }, 'nl')[0].label, 'Schutten aanvragen');
});
test('stations: rows, silent ones skipped by Tab, cycling both ways', () => {
  const st = [{ id: 'a', name: 'A', bars: 4 }, { id: 'b', name: 'B', silent: true, why: 'out of hours until 06:00' }, { id: 'c', name: 'C', bars: 2 }];
  assert.equal(stationRows(st, 'c')[2].sel, true);
  assert.equal(stationRows(st)[1].label, 'B — silent: out of hours until 06:00');
  assert.equal(nextTarget(st, null).id, 'a');
  assert.equal(nextTarget(st, 'a').id, 'c');
  assert.equal(nextTarget(st, 'c').id, 'a');
  assert.equal(nextTarget(st, 'a', -1).id, 'c');
  assert.equal(nextTarget([], null), null);
});
test('digits, knob, timing, escaping', () => {
  assert.equal(parseDigits('68'), 68);
  assert.equal(parseDigits('70'), null);
  assert.equal(parseDigits('6'), 6);
  assert.equal(parseDigits('99'), null);
  assert.equal(knobAngle(1), -150);
  assert.equal(knobAngle(88), 150);
  assert.ok(playSeconds('x') >= 1.2 && playSeconds('x'.repeat(1000)) <= 9);
  assert.equal(esc('<b>"&'), '&lt;b&gt;&quot;&amp;');
  assert.equal(barsText(2), '▮▮▯▯');
});
