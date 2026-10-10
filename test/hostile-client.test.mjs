// Hostile AI ships, client side that runs under Node: the formatters (banner, chip, risk block, labels) and static wiring checks
// of the files that need a browser (models, motion classes, sound cues, hooks). Contract R14, R15.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { unitLabel, unitColor, bannerModel, bannerHTML, chipModel, riskBlockHTML, expressWarning, esc } from '../public/js/hostilefmt.js';
import { KINDS, HOSTILE, HOSTILE_TEXT, labelOf, preyScore, pirateRatePerH, navyRatePerH, rollP, groupSize, detectRangeM, identRangeM, isNight, dayKey, ransomFor } from '../shared/hostile.js';
import { bannedHits } from '../scripts/politics/validate.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const NO_INJURY = /injur|wound|bleed|dead|killed|casualt|hostage/i;

test('labels: unidentified craft stay anonymous, identified ones are named, a friendly patrol is never "pirate"', () => {
  assert.equal(unitLabel({ k: 'skiff', f: 'pirate', ident: false }), 'Unknown fast craft');
  assert.equal(unitLabel({ k: 'skiff', f: 'pirate', ident: true, name: 'Pirate skiff' }), 'Pirate skiff');
  assert.equal(unitLabel({ k: 'corvette', f: 'navy', ident: false }), 'Unknown warship');
  assert.equal(unitLabel({ k: 'patrol', f: 'navy', ident: true, name: 'Naval patrol Vigilant' }), 'Naval patrol Vigilant');
  assert.equal(unitLabel({ k: 'patrol', f: 'friend', ident: false }), 'Naval vessel');
  assert.equal(labelOf({ k: 'patrol', role: 'friend', ident: true }), 'Anti-piracy patrol');
  assert.equal(unitColor({ f: 'pirate' }), '#ff2a2a'); assert.notEqual(unitColor({ f: 'friend' }), unitColor({ f: 'pirate' }));
});

test('pirate banner: title and buttons follow the state, the release payment greys out when you cannot pay', () => {
  const base = { f: 'pirate', st: 'approach', label: 'Unknown fast craft', ident: false, n: 2, dist: 3400, brg: 45, board: 0, citadel: false, comply: false, ransom: 12000, hose: 3, navyCalled: false };
  let m = bannerModel(base, 1e6);
  assert.equal(m.title, 'UNKNOWN FAST CRAFT CLOSING'); assert.equal(m.tone, 'pirate');
  assert.deepEqual(m.buttons.map((b) => b.act), ['hostile_navy', 'hostile_hose', 'hostile_citadel', 'hostile_pay', 'hostile_cargo', 'hostile_surrender', 'client_bino']);
  assert.equal(m.buttons.find((b) => b.act === 'hostile_pay').disabled, false);
  assert.equal(bannerModel(base, 100).buttons.find((b) => b.act === 'hostile_pay').disabled, true);
  assert.match(bannerModel({ ...base, ident: true }, 1e6).title, /PIRATES CLOSING/);
  m = bannerModel({ ...base, st: 'attack', board: 0.4 }, 1e6); assert.equal(m.title, 'PIRATES BOARDING'); assert.match(m.sub, /boarding 40 %/);
  assert.equal(bannerModel({ ...base, st: 'attack' }, 1e6).title, 'PIRATE ATTACK');
  m = bannerModel({ ...base, st: 'attack', citadel: true }, 1e6); assert.equal(m.title, 'CITADEL: CREW LOCKED IN'); assert.ok(!m.buttons.some((b) => b.act === 'hostile_citadel'));
  m = bannerModel({ ...base, st: 'attack', comply: true }, 1e6); assert.equal(m.title, 'YOU HAVE SURRENDERED'); assert.ok(!m.buttons.some((b) => b.act === 'hostile_surrender'));
  assert.equal(bannerModel({ ...base, hose: 0 }, 1e6).buttons.find((b) => b.act === 'hostile_hose').disabled, true);
  assert.equal(bannerModel({ ...base, navyCalled: true }, 1e6).buttons[0].disabled, true);
  assert.equal(bannerModel(null), null);
});

test('navy banner: hail with a demand and countdown, fire, search; only a surrender button', () => {
  const base = { f: 'navy', st: 'hail', label: 'Naval patrol', ident: true, name: 'Naval patrol Vigilant', n: 1, dist: 2100, brg: 270, demand: 'carries cargo that is banned (contraband)', left: 42 };
  let m = bannerModel(base);
  assert.equal(m.title, 'HEAVE TO FOR INSPECTION'); assert.match(m.sub, /Naval patrol Vigilant .* banned .* 42 s/); assert.equal(m.tone, 'navy');
  assert.deepEqual(m.buttons.map((b) => b.act), ['hostile_surrender', 'client_bino']);
  assert.equal(bannerModel({ ...base, demand: null, left: null }).title, 'NAVAL PATROL HAILING');
  m = bannerModel({ ...base, st: 'fire' }); assert.equal(m.title, 'UNDER NAVAL FIRE'); assert.equal(m.buttons[0].danger, true);
  assert.equal(bannerModel({ ...base, st: 'inspect' }).title, 'BOARDING PARTY ABOARD'); assert.deepEqual(bannerModel({ ...base, st: 'inspect' }).buttons.map((b) => b.act), ['client_bino']);
  assert.equal(bannerModel({ ...base, st: 'approach', ident: false, name: null }).title, 'WARSHIP CLOSING');
});

test('banner and risk-block HTML are escaped and never describe injuries (crews are always safe)', () => {
  const html = bannerHTML(bannerModel({ f: 'navy', st: 'hail', label: '<b>x</b>', ident: true, name: 'A<script>', dist: 1000, brg: 1, demand: 'y"z', left: 3 }));
  assert.ok(!html.includes('<script>') && !html.includes('<b>x</b>')); assert.match(html, /A&lt;script&gt;/);
  for (const t of [HOSTILE_TEXT.warn, HOSTILE_TEXT.riskOn, HOSTILE_TEXT.riskOff]) assert.doesNotMatch(t, NO_INJURY);
  const block = riskBlockHTML(false, [{ kind: 'piracy', name: 'Gulf of Guinea' }, { kind: 'war_risk', name: 'Red Sea' }]);
  assert.doesNotMatch(block, NO_INJURY);
  assert.deepEqual(bannedHits(HOSTILE_TEXT.warn.replace(/ransom/g, '')), []);
});

test('chip: OFF by default, ON shows the day count and the full warning in the tooltip', () => {
  assert.equal(chipModel(null).text, 'Risk OFF'); assert.equal(chipModel(null).on, false);
  const m = chipModel({ on: true, today: 1, max: 3, cooldown: 600 });
  assert.equal(m.text, 'Risk ON · 1/3'); assert.equal(m.on, true); assert.match(m.title, /no new hostile for 10 min/); assert.match(m.title, /0 % hull sinks/);
});

test('risk block on the voyage risk check: nothing without a danger area; the switch and what can happen with one', () => {
  assert.equal(riskBlockHTML(false, [{ kind: 'eca', name: 'Baltic' }]), ''); assert.equal(riskBlockHTML(true, []), '');
  const off = riskBlockHTML(false, [{ kind: 'piracy', name: 'Gulf of Guinea' }]);
  assert.match(off, /Risk mode is OFF/); assert.match(off, /Accept the risk/); assert.match(off, /pirates may chase and board you/); assert.match(off, /data-pol="riskMode"/);
  assert.doesNotMatch(off, /naval patrols may search/);
  const on = riskBlockHTML(true, [{ kind: 'war_risk', name: 'Red Sea' }]);
  assert.match(on, /Risk mode is ON/); assert.match(on, /Turn risk mode off/); assert.match(on, /Red Sea/);
  assert.match(riskBlockHTML(false, [{ kind: 'piracy', name: 'A' }, { kind: 'war_risk', name: 'B' }]), /pirates may chase and board you and naval patrols may search you/);
  assert.equal(expressWarning(false, [{ kind: 'piracy', name: 'A' }]), '', 'no warning when the risk is off');
  assert.match(expressWarning(true, [{ kind: 'piracy', name: 'Gulf of Guinea' }]), /crosses Gulf of Guinea/);
  assert.equal(expressWarning(true, []), '');
  assert.equal(esc('<&>'), '&lt;&amp;&gt;');
});

test('shared pure rules: detection ranges, prey score, rates, group size, night, day key, release payment', () => {
  assert.ok(detectRangeM(false) > detectRangeM(true)); assert.equal(detectRangeM(false, 0.5), Math.round(HOSTILE.DETECT_DAY_M * 0.5)); assert.equal(detectRangeM(false, 0), Math.round(HOSTILE.DETECT_DAY_M * 0.35));
  assert.ok(identRangeM(false) > identRangeM(true));
  assert.equal(preyScore({ spd: 22 }), 0); assert.equal(preyScore({ spd: -25 }), 0);
  assert.ok(preyScore({ spd: 6, loadFrac: 1 }) > preyScore({ spd: 6, loadFrac: 0 }));
  assert.ok(preyScore({ spd: 6, loadFrac: 1 }) > preyScore({ spd: 18, loadFrac: 1 }));
  assert.ok(Math.abs(preyScore({ spd: 6, loadFrac: 1, escorted: true }) - preyScore({ spd: 6, loadFrac: 1 }) / 2) < 0.002);
  assert.ok(preyScore({ spd: 6, loadFrac: 1, guards: true }) < 0.25);
  assert.ok(preyScore({ spd: 6, loadFrac: 1, length: 300 }) < preyScore({ spd: 6, loadFrac: 1 }));
  assert.equal(pirateRatePerH({ p100: 0.004 }, 0.5), 0.004 * HOSTILE.PIRACY_K * 0.5); assert.equal(pirateRatePerH(null, 1), 0);
  assert.equal(navyRatePerH({ tier: 4 }, true), 3 * navyRatePerH({ tier: 4 }, false)); assert.equal(navyRatePerH({ tier: 2 }, true), 0);
  assert.ok(rollP(1, 3600) > 0.63 && rollP(1, 3600) < 0.64); assert.equal(rollP(0, 100), 0);
  assert.deepEqual([0.1, 0.6, 0.95].map((r) => groupSize(r, 0.5)), [1, 2, 3]);
  const noon = Date.UTC(2026, 9, 10, 12) / 1000;
  assert.equal(isNight(0, 0, noon), false); assert.equal(isNight(0, 0, noon + 12 * 3600), true); assert.equal(isNight(0, 105, noon), true, 'lon 105 E is 7 h ahead: 19:00 local');
  assert.equal(dayKey(noon), '2026-10-10');
  assert.equal(ransomFor(10000), HOSTILE.RANSOM_MIN); assert.equal(ransomFor(1e6), 30000);
  for (const [k, K] of Object.entries(KINDS)) { assert.ok(K.kn > 20 && K.turn > 0 && K.len > 0, k); assert.ok(['pirate', 'navy'].includes(K.faction)); }
});

test('browser-only files are wired: the four hulls exist in ship.js and motion.js, sound cues, hooks in main / hud / chart / politics', () => {
  const ship = read('public/js/ship.js'), motion = read('public/js/motion.js'), snd = read('public/js/sound.js');
  for (const k of Object.keys(KINDS)) {
    assert.match(ship, new RegExp(`${k}: \\{ id: '${k}'`), `EXTRA_CLASSES ${k}`);
    assert.match(motion, new RegExp(`\\n  ${k}: \\{ gm:`), `MOTION_CLASSES ${k}`);
  }
  assert.match(ship, /skiff\(ctx\)/); assert.match(ship, /patrol: warship, corvette: warship, frigate: warship/);
  assert.match(snd, /case 'shot':/); assert.match(snd, /case 'alarm':/);
  const main = read('public/js/main.js');
  for (const hook of ["import('./hostile.js')", 'this.hostile?.sync(m.hostiles, now)', 'this.hostile?.update(dt, now)', 'this.hostile.radarContacts()']) assert.ok(main.includes(hook), hook);
  assert.ok(read('public/js/hud.js').includes("c.kind === 'hostile'")); assert.ok(read('public/js/chart.js').includes('a.hostile?.drawChart(this)'));
  assert.ok(read('public/js/politics.js').includes("case 'riskMode'")); assert.ok(read('public/js/politicsview.js').includes('o.hostileBlock'));
  assert.match(read('public/js/hostile.js'), /classList|riskChip/);
  assert.ok(fs.existsSync(new URL('../public/css/hostile.css', import.meta.url)));
});
