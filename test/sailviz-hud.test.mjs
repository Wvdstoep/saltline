// Sailing HUD — pure formatters and the key map (public/js/sailfmt.js): docs/SAILING-CONTRACT.md §0.2, §3.3, §5,
// §6.4 B-3. Advice priority comes from shared/sail/trim.js (not re-typed); slider ↔ sheet mapping; % of target
// colours; keys without collisions; the signed relative wind (the "sails to windward" fix).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../public/js/sailfmt.js';
import { defaultRig, applyRigCommand, settleRig } from '../shared/sail/state.js';
import { KN } from '../shared/sail/rigs.js';

function rigWith(o = {}) {
  const rig = defaultRig('sloop', { hoisted: true });
  settleRig(rig);
  Object.assign(rig, { tws: 12 * KN, twa: 60, heel: -10, irons: 0, flags: 0 }, o);
  for (const k in rig.sails) rig.sails[k].state = 0;
  return rig;
}

test('advice priority: irons > by-the-lee > no-go > round-up > hull flying > heel > luff > stall > reef out > good', () => {
  const key = (rig, cls = 'sloop') => F.adviceOf(cls, rig).key;
  // stack every condition, then remove them one by one from the top
  const all = rigWith({ irons: 5, flags: 1 | 2, twa: 20, heel: -40 });
  all.sails.genoa.state = 1; all.sails.main.state = 3;
  assert.equal(key(all), 'irons');
  all.irons = 0; assert.equal(key(all), 'bylee');
  all.flags = 2; assert.equal(key(all), 'nogo');
  all.twa = 60; assert.equal(key(all), 'roundup');
  all.flags = 0; assert.equal(key(all), 'heel');
  all.heel = -10; assert.equal(key(all), 'luff:genoa');
  all.sails.genoa.state = 0; assert.equal(key(all), 'stall:main');
  all.sails.main.state = 0; all.tws = 8 * KN; all.sails.main.reef = 1; assert.equal(key(all), 'reef_out');
  all.sails.main.reef = 0; assert.equal(key(all), 'good');
  // catamaran: hull flying comes after round-up and before heel
  const cat = defaultRig('catamaran', { hoisted: true }); settleRig(cat);
  Object.assign(cat, { tws: 25 * KN, twa: 60, flags: 4 }); for (const k in cat.sails) cat.sails[k].state = 0;
  assert.equal(key(cat, 'catamaran'), 'flying');
  // texts are the shared ones; levels colour the line
  assert.equal(F.adviceOf('sloop', rigWith()).text, 'Good trim.');
  assert.equal(F.adviceLevel('bylee'), 'danger'); assert.equal(F.adviceLevel('luff:genoa'), 'warn'); assert.equal(F.adviceLevel('good'), 'good'); assert.equal(F.adviceLevel('reef_out'), 'info');
  // the HUD's rank table agrees with the order the shared function applies
  const order = ['irons', 'bylee', 'nogo', 'roundup', 'flying', 'heel', 'luff:x', 'stall:x', 'reef_out', 'good'];
  for (let i = 1; i < order.length; i++) assert.ok(F.adviceRank(order[i - 1]) < F.adviceRank(order[i]));
  // no sail set → no advice
  const down = defaultRig('sloop', { hoisted: false });
  assert.equal(F.adviceOf('sloop', down), null);
});

test('slider ↔ sheet / traveller mapping round-trips; the green tick and good band are percentages', () => {
  for (const s of [0, 0.013, 0.25, 0.5, 0.731, 1]) assert.ok(Math.abs(F.sliderToSheet(F.sheetToSlider(s)) - s) <= 0.0005);
  assert.equal(F.sheetToSlider(1.7), F.SLIDER_MAX); assert.equal(F.sheetToSlider(-1), 0); assert.equal(F.sheetToSlider(NaN), 0);
  for (const t of [-1, -0.3, 0, 0.42, 1]) assert.ok(Math.abs(F.sliderToTrav(F.travToSlider(t)) - t) <= 0.002);
  assert.equal(F.sliderToTrav(0), -1); assert.equal(F.sliderToTrav(F.SLIDER_MAX), 1);
  assert.equal(F.tickPct(0.37), 37);
  assert.equal(F.sheetStep(true), 0.01); assert.equal(F.sheetStep(false), 0.05);
  assert.ok(F.crossedOptimum(0.2, 0.4, 0.3)); assert.ok(!F.crossedOptimum(0.2, 0.25, 0.3)); assert.ok(F.crossedOptimum(0.4, 0.3, 0.3));
});

test('% of target colours, heel / helm / hull-load zones, status colours, telltale codes', () => {
  assert.equal(F.pctColor(0.97), 'green'); assert.equal(F.pctColor(0.95), 'green'); assert.equal(F.pctColor(0.9), 'amber'); assert.equal(F.pctColor(0.8), 'amber'); assert.equal(F.pctColor(0.79), 'red'); assert.equal(F.pctColor(NaN), 'red');
  assert.equal(F.heelZone(-20, 22), 'green'); assert.equal(F.heelZone(28, 22), 'amber'); assert.equal(F.heelZone(31, 22), 'red');
  assert.equal(F.helmZone(0.5), 'green'); assert.equal(F.helmZone(-0.9), 'amber'); assert.equal(F.helmZone(1.2), 'red');
  assert.equal(F.loadZone(0.5), 'green'); assert.equal(F.loadZone(0.6), 'amber'); assert.equal(F.loadZone(0.7), 'red');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(F.stateColor), ['green', 'amber', 'red', 'red', 'blue', 'grey']);
  assert.deepEqual(F.ttCodes(0b100100), [0, 1, 2]);
});

test('keys (§0.2): Q, Shift+Q, 1–7, Shift+digit, ] [, Ctrl+] Ctrl+[, = -, R, Shift+R, Z — none collides with the game keys', () => {
  const k = (key, code, mods = {}) => F.keyAction({ key, code, ...mods });
  assert.deepEqual(k('q', 'KeyQ'), { type: 'panel' });
  assert.deepEqual(k('Q', 'KeyQ', { shiftKey: true }), { type: 'auto' });
  assert.deepEqual(k('3', 'Digit3'), { type: 'select', i: 2 });
  assert.deepEqual(k('#', 'Digit3', { shiftKey: true }), { type: 'hoist', i: 2 });       // US layout: Shift+3 = '#'
  assert.deepEqual(k(']', 'BracketRight'), { type: 'sheet', d: -1, fine: false });
  assert.deepEqual(k('{', 'BracketLeft', { shiftKey: true }), { type: 'sheet', d: 1, fine: true });
  assert.deepEqual(k(']', 'BracketRight', { ctrlKey: true }), { type: 'sheetAll', d: -1 });
  assert.deepEqual(k('=', 'Equal'), { type: 'trav', d: -1 });
  assert.deepEqual(k('-', 'Minus'), { type: 'trav', d: 1 });
  assert.deepEqual(k('r', 'KeyR'), { type: 'reef', d: 1 });
  assert.deepEqual(k('R', 'KeyR', { shiftKey: true }), { type: 'reef', d: -1 });
  assert.deepEqual(k('z', 'KeyZ'), { type: 'maneuver' });
  assert.equal(k('8', 'Digit8'), null); assert.equal(k('w', 'KeyW'), null); assert.equal(k('q', 'KeyQ', { metaKey: true }), null);
  for (const key of F.SAIL_KEYS) assert.ok(!F.GAME_KEYS.includes(key), `${key} collides with a game key`);
  assert.deepEqual(F.SAIL_KEYS.filter((x) => F.GAME_KEYS_CHART_ONLY.includes(x)), ['r']);   // R: chart mode only while the chart is open (handled first)
  // every game key still maps to nothing here (WASD, arrows, space…)
  for (const key of F.GAME_KEYS) assert.equal(F.keyAction({ key, code: '' }), null, key);
});

test('key actions become rig commands (§3.4) against the TrimInfo', () => {
  const info = { auto: 'hint', twa: 50, sails: [
    { id: 'genoa', hoist: 1, sheet: 0.3, sheetOpt: 0.2, trav: 0, travOpt: 0, reef: 0, reefs: 0, canFurl: true, boom: false },
    { id: 'main', hoist: 1, sheet: 0.5, sheetOpt: 0.4, trav: 0.2, travOpt: -0.1, reef: 1, reefs: 2, canFurl: false, boom: true },
  ] };
  assert.deepEqual(F.actionToCommand({ type: 'sheet', d: -1, fine: false }, info, 0), { cmd: { sails: { genoa: { sheet: 0.25 } } } });
  assert.deepEqual(F.actionToCommand({ type: 'sheet', d: 1, fine: true }, info, 1).cmd.sails.main.sheet, 0.51);
  assert.deepEqual(F.actionToCommand({ type: 'trav', d: -1 }, info, 1), { cmd: { sails: { main: { trav: 0.1 } } } });
  assert.equal(F.actionToCommand({ type: 'trav', d: -1 }, info, 0), null);               // a genoa has no traveller
  assert.deepEqual(F.actionToCommand({ type: 'reef', d: 1 }, info, 1), { cmd: { sails: { main: { reef: 2 } } } });
  assert.equal(F.actionToCommand({ type: 'reef', d: 1 }, info, 0), null);
  assert.deepEqual(F.actionToCommand({ type: 'hoist', i: 0 }, info, 0), { cmd: { sails: { genoa: { hoist: 0 } } } });
  assert.deepEqual(F.actionToCommand({ type: 'auto' }, info), { cmd: { auto: 'full' } });
  assert.deepEqual(F.actionToCommand({ type: 'maneuver' }, info), { maneuver: 'tack', cmd: { maneuver: 'tack' } });
  assert.deepEqual(F.actionToCommand({ type: 'maneuver' }, { ...info, twa: -140 }).maneuver, 'jibe');
  assert.deepEqual(F.actionToCommand({ type: 'select', i: 1 }, info), { ui: 'select', i: 1 });
  assert.equal(F.actionToCommand({ type: 'select', i: 5 }, info), null);
  assert.deepEqual(F.trimAllCommand(info), { sails: { genoa: { sheet: 0.2 }, main: { sheet: 0.4, trav: -0.1 } } });
  assert.deepEqual(F.nextAuto('off'), 'hint'); assert.deepEqual(F.nextAuto('hint'), 'full'); assert.deepEqual(F.nextAuto('full'), 'off');
  // the produced commands are valid for the shared validator
  const rig = defaultRig('sloop', { hoisted: true });
  assert.deepEqual(applyRigCommand('sloop', rig, F.trimAllCommand(info)), { ok: true });
});

test('windRel signed fix: wind from port is negative, from starboard positive (sails go to the other side)', () => {
  assert.equal(F.windRelSigned(270, 0), -90);      // heading north, wind from the west = over the port side
  assert.equal(F.windRelSigned(90, 0), 90);
  assert.equal(F.windRelSigned(10, 350), 20);
  assert.equal(F.windRelSigned(340, 10), -30);
  assert.equal(F.windRelSigned(180, 0), 180);
  // the legacy windRel returned 0…360: 270 → setSails' side test (rel > 0) put the boom to port, i.e. to windward
  const legacy = ((270 - 0) % 360 + 360) % 360;
  assert.ok(legacy > 0 && F.windRelSigned(270, 0) < 0);
  assert.equal(F.fmtSide(-45), '45° P'); assert.equal(F.fmtSide(120), '120° S'); assert.equal(F.fmtDeg(-3), '357°');
  assert.equal(F.maneuverFor(89), 'tack'); assert.equal(F.maneuverFor(-91), 'jibe'); assert.equal(F.maneuverLabel(30), 'Tack');
});

test('VMG to the wind, VMC to the waypoint; labels; chips in RIGS order', () => {
  const g = F.vmgInfo({ stwKn: 6, twaDeg: 45 }); assert.equal(g.label, 'VMG'); assert.ok(Math.abs(g.kn - 6 * Math.SQRT1_2) < 1e-9);
  const c = F.vmgInfo({ stwKn: 6, sogKn: 7, twaDeg: 45, cogDeg: 30, brgDeg: 90 }); assert.equal(c.label, 'VMC'); assert.ok(Math.abs(c.kn - 3.5) < 1e-9);
  assert.equal(F.hoistLabel({ canFurl: true }), ''); assert.equal(F.hoistLabel({ canFurl: false, hoist: 1 }), 'Lower'); assert.equal(F.hoistLabel({ canFurl: false, hoist: 0, job: 'hoist' }), 'Lower');
  assert.equal(F.reefLabel({ reefs: 2, reef: 1 }), 'Reef 1/2'); assert.equal(F.reefLabel({ reefs: 0 }), '');
  assert.equal(F.jobProgress({ job: 'hoist', work: 3 }, 12), 0.75);
  assert.deepEqual(F.sailChips('schooner').map((x) => x.id), ['flyjib', 'jib', 'stay', 'fore', 'foretop', 'main', 'maintop']);
  assert.deepEqual(F.sailChips('coaster'), []);
});

// Found in the phone browser run (phase 2): hud.js adoptHelm() gives main.js's TouchHelm an onAction that only knows the
// HUD's own actions; touch.js preferred onAction, so the Sails and Tack round buttons silently did nothing.
test('touch helm: the Sails and Tack round buttons reach onSails / onTack even when an onAction is installed', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const shared = new URL('../shared/', import.meta.url).href;
  const src = fs.readFileSync(new URL('../public/js/touch.js', import.meta.url), 'utf8').replace(/from '\/shared\//g, `from '${shared}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-touch-')), file = path.join(dir, 'touch.mjs');
  fs.writeFileSync(file, src);
  const { TouchHelm } = await import(new URL('file://' + file).href);
  const calls = [];
  const h = new TouchHelm(null, { buttons: ['stop', 'auto', 'sails', 'tack'], onAction: (n) => calls.push('hud:' + n), onSails: () => calls.push('sails'), onTack: () => calls.push('tack'), onAllStop: () => calls.push('stop') });
  clearInterval(h._timer);
  for (const n of ['sails', 'tack', 'auto', 'stop']) h.fire(n);
  assert.deepEqual(calls, ['sails', 'tack', 'hud:auto', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});
