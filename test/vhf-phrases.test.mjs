// VHF phrases: EN/NL rendering from the same id + args, context sorting, auto-filled args (§6.4, §10.6.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, textOf, phrasesFor, autoArgs, langFor, typeKeyOf, PHRASE_IDS, PLAYER_PHRASES, PHRASE_LABEL, isPlayerPhrase, fmtNum } from '../shared/vhfphrases.js';

const ship = { name: 'Saltwind', hdg: 10, lat: 51.885, lon: 4.227, ad: 17.0, T: 1.9, L: 11, B: 3.6, type: 'sail_yacht' };

test('§10.6.6 snapshot: req_open EN / NL from the same id + args', () => {
  const a = { ...autoArgs(ship), to: 'Rozenburgsesluis' };
  assert.equal(render('req_open', a, 'en'), 'Rozenburgsesluis, this is Saltwind, northbound on the approach, air draught 17.0 metres, request bridge opening, over.');
  assert.equal(render('req_open', a, 'nl'), 'Rozenburgsesluis, hier is de Saltwind, noordgaand in de aanloop, hoogte 17,0 meter, graag een brugopening, over.');
});
test('snapshot: call, req_lock, ack, pass, overtake', () => {
  const a = { ...autoArgs(ship, { side: 'stbd' }), to: 'Botlekbrug' };
  assert.equal(render('call', a, 'en'), 'Botlekbrug, Botlekbrug, this is Saltwind, Saltwind, over.');
  assert.equal(render('call', a, 'nl'), 'Botlekbrug, Botlekbrug, hier is de Saltwind, Saltwind, over.');
  assert.equal(render('req_lock', a, 'en'), 'Botlekbrug, this is Saltwind, northbound, sailing yacht 11 by 3.6 metres, draught 1.9, request lock passage, over.');
  assert.equal(render('req_lock', a, 'nl'), 'Botlekbrug, hier is de Saltwind, noordgaand, zeiljacht 11 bij 3,6 meter, diepgang 1,9, verzoek om te schutten, over.');
  assert.equal(render('ack', a, 'en'), 'Received, Botlekbrug, out.');
  assert.equal(render('ack', a, 'nl'), 'Begrepen, Botlekbrug, sluiten.');
  assert.equal(render('pass_port', a, 'en'), 'Botlekbrug, this is Saltwind, I will pass you port to port, over.');
  assert.equal(render('overtake', a, 'en'), 'Botlekbrug, this is Saltwind, request to overtake you on your starboard side, over.');
  assert.equal(render('overtake', a, 'nl'), 'Botlekbrug, hier is de Saltwind, verzoek u op te lopen aan uw stuurboordzijde, over.');
});
test('snapshot: operator replies (bridge wait / under / opening / never, lock queue, VTS, coast guard)', () => {
  const b = { ship: 'Saltwind', st: 'Rozenburgsesluis' };
  assert.equal(render('op_br_wait', { ...b, in: 5, hhmm: '14:25', n: 1, where: 'waiting' }, 'en'), 'Saltwind, Rozenburgsesluis. Next opening in 5 minutes at 14:25, you are number 1. Wait at the waiting berth, over.');
  assert.equal(render('op_br_wait', { ...b, in: 5, hhmm: '14:25', n: 1, where: 'waiting' }, 'nl'), 'Saltwind, Rozenburgsesluis. Volgende opening over 5 minuten om 14:25, u bent nummer 1. Wacht bij de wachtplaats, over.');
  assert.equal(render('op_br_under', { ...b, clr: 14.2 }, 'en'), 'Saltwind, Rozenburgsesluis. Clearance is 14.2 metres now, you can pass under. Rozenburgsesluis out.');
  assert.equal(render('op_br_opening', b, 'en'), 'Saltwind, Rozenburgsesluis, bridge is opening, proceed on green.');
  assert.equal(render('op_br_opening', b, 'nl'), 'Saltwind, Rozenburgsesluis, de brug gaat open, doorvaren op groen.');
  assert.equal(render('op_br_never', { ...b, clrO: 24, alt: 'Calandbrug' }, 'en'), 'Saltwind, Rozenburgsesluis. Open clearance is 24.0 metres, you will not pass. Advise route via Calandbrug.');
  assert.equal(render('op_lk_queue', { ...b, n: 2, chamber: 'A', dir: 'south', in: 9, side: 'stbd', where: 'waiting' }, 'en'),
    'Saltwind, Rozenburgsesluis. You are number 2 for chamber A, next southbound cycle in 9 minutes. Make fast starboard side at the waiting berth, over.');
  assert.equal(render('op_vts_redirect', { ship: 'Saltwind', st: 'Oude Maas', x: 'Maasbruggen', y: 81 }, 'en'), 'Saltwind, Oude Maas. You are in sector Maasbruggen, call on channel 81.');
  assert.equal(render('op_vts_redirect', { ship: 'Saltwind', st: 'Oude Maas', x: 'Maasbruggen', y: 81 }, 'nl'), 'Saltwind, Oude Maas. U bent in sector Maasbruggen, roep op kanaal 81.');
  assert.equal(render('op_vts_ack', { ship: 'Saltwind', st: 'Maasbruggen', dir: 'east', dest: 'Dordrecht', traffic: ['Nordic Star', 'Rhine Queen'] }, 'en'), 'Saltwind, Maasbruggen. Roger, eastbound to Dordrecht. Traffic: Nordic Star and Rhine Queen. Maasbruggen out.');
  assert.equal(render('op_vts_ack', { ship: 'Saltwind', st: 'Maasbruggen', dir: 'east', dest: 'Dordrecht', traffic: [] }, 'nl'), 'Saltwind, Maasbruggen. Begrepen, oostgaand naar Dordrecht. Verkeer: geen verkeer gemeld. Maasbruggen sluiten.');
  assert.equal(render('op_cg_switch', { ship: 'Saltwind', st: 'Netherlands Coastguard', y: 67 }, 'en'), 'Saltwind, Netherlands Coastguard, switch to channel 67, over.');
});
test('the lock queue "where" reads naturally with a key and with a place name', () => {
  const s = render('op_lk_queue', { ship: 'A', st: 'B', n: 1, chamber: 'A', dir: 'north', in: 3, side: 'port', where: 'lockS' }, 'en');
  assert.match(s, /Make fast port side at the south waiting berth, over\.$/);
  assert.match(render('vts_report', { to: 'X', me: 'Y', where: 'Calandkanaal', dir: 'east', dest: 'Botlek', T: 4.1 }, 'en'), /^X, this is Y, at Calandkanaal, eastbound to Botlek, draught 4\.1, over\.$/);
});
test('every phrase id exists in English and Dutch and renders without leftover slots', () => {
  const args = { ...autoArgs(ship), to: 'X', ship: 'S', st: 'ST', in: 1, hhmm: '10:00', n: 1, clr: 3, clrO: 24, alt: 'Y', why: 'rush', chamber: 'A', fee: 6, slot: 20, head: 'upper', dh: 1.2, min: 4, dest: 'Z', traffic: [], x: 'Q', y: 81, q: 4, kind: 'distress' };
  for (const id of PHRASE_IDS) for (const L of ['en', 'nl']) {
    const s = render(id, args, L);
    assert.ok(s.length > 5, `${id} ${L}`);
    assert.ok(!/\{\w+\}/.test(s), `${id} ${L}: ${s}`);
  }
  for (const id of PLAYER_PHRASES) { assert.ok(PHRASE_LABEL.en[id] && PHRASE_LABEL.nl[id], id); assert.ok(isPlayerPhrase(id)); }
  assert.equal(isPlayerPhrase('op_br_wait'), false);
  assert.equal(render('nope', {}, 'en'), '');
});
test('textOf: free text as is, phrases in the receiver language; missing args show "?"', () => {
  assert.equal(textOf({ text: 'Hello Rotterdam' }, 'nl'), 'Hello Rotterdam');
  assert.equal(textOf({ phrase: 'say_again', args: {} }, 'nl'), 'Herhaal, over.');
  assert.match(render('op_br_wait', { ship: 'A', st: 'B' }, 'en'), /in \? minutes/);
});
test('context sorting: "Request opening" first near a movable bridge; lock → lock passage; VTS → report; ship → passing', () => {
  assert.equal(phrasesFor({ near: { kind: 'bridge' } })[0], 'req_open');
  assert.equal(phrasesFor({ target: { kind: 'lock' } })[0], 'req_lock');
  assert.equal(phrasesFor({ target: { kind: 'vts' } })[0], 'vts_report');
  assert.deepEqual(phrasesFor({ target: { kind: 'ship' } }).slice(0, 3), ['pass_port', 'pass_stbd', 'overtake']);
  assert.equal(phrasesFor({})[0], 'call');
  const all = phrasesFor({ near: { kind: 'bridge' } });
  assert.equal(new Set(all).size, all.length);
  assert.ok(!all.includes('mayday'));                    // MAYDAY is the DISTRESS button's job
});
test('autoArgs fills name, direction, air draught, size; language choice (Q16)', () => {
  const a = autoArgs(ship, { dest: 'Dordrecht' });
  assert.deepEqual([a.me, a.dir, a.ad, a.L, a.B, a.T, a.dest, a.side], ['Saltwind', 'north', 17, 11, 3.6, 1.9, 'Dordrecht', 'port']);
  assert.equal(langFor('nl'), 'nl');
  assert.equal(langFor('auto', { inlandNL: true, uiLang: 'nl-NL' }), 'nl');
  assert.equal(langFor('auto', { inlandNL: true, uiLang: 'en-GB' }), 'en');
  assert.equal(langFor('auto', { inlandNL: false, uiLang: 'nl' }), 'en');
  assert.equal(fmtNum(3.6, 'nl'), '3,6');
});
test('DSC alert line and MAYDAY carry the position in degrees and minutes', () => {
  const s = render('dsc_alert', { me: 'Saltwind', kind: 'distress', pos: [51.885, 4.227], nature: 'fire' }, 'en');
  assert.equal(s, 'DSC DISTRESS alert from Saltwind, position 51°53.1′N 4°13.6′E, fire on board.');
  assert.match(render('mayday', { me: 'Saltwind', pos: [51.885, 4.227], nature: 'sinking', pob: 2 }, 'nl'), /MAYDAY Saltwind, positie 51°53\.1′N 4°13\.6′E, zinkend, 2 personen aan boord/);
});

test('typeKeyOf maps class ids to phrase ship types', () => {
  assert.deepEqual(['sloop', 'schooner', 'flybridge18', 'tug', 'tanker', 'feeder', 'coaster', 'kempenaar', 'bulker', 'pilot', 'mystery'].map((c) => typeKeyOf(c)),
    ['sail_yacht', 'sail_yacht', 'motor_yacht', 'tug', 'tanker', 'container', 'general', 'barge', 'bulk', 'pilot', 'ship']);
  assert.equal(typeKeyOf('x', { sail: true }), 'sail_yacht');
});
