// Contract §7 politics-wording: fixed neutral templates (§2.1); crews are always safe (P5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, fill, DISCLAIMER, STATUS_REASONS } from '../shared/politics.js';
import { bannedHits, proseStrings, BANNED_WORDS } from '../scripts/politics/validate.mjs';
import { readParts } from '../server/politics.js';
import { makePolitics, player, at } from './politics-helpers.mjs';

// Heads of state and government whose names never appear in data or templates (small list, extend as needed).
export const PERSON_NAMES = ['putin', 'zelensky', 'zelenskyy', 'biden', 'trump', 'xi jinping', 'netanyahu', 'khamenei', 'pezeshkian', 'erdogan', 'erdoğan', 'macron', 'starmer', 'merz', 'scholz', 'modi', 'lula', 'maduro', 'lukashenko', 'kim jong un'];
const VARS = { ship: 'Sea Lark', where: 'at 44.10°, 30.20°', n: 8, h: 12, areaName: 'Fixture listed area', srcShort: 'JWC', asOf: '01 Oct 2026', reason: 'corridor route required', measureText: 'Act A Art. 1: import of XE steel', harbour: 'Alpha Port', cr: 5000, regime: 'Fixture MoU', cond: 60, qty: 10, good: 'Steel', origin: 'XE', fine: '10,000' };
const CREW = ['mine', 'projectile', 'detention', 'loss', 'robbery', 'repelled', 'hijack', 'psc'];

test('every template rendered with fixture data is free of banned words and person names', () => {
  assert.ok(BANNED_WORDS.includes('ransom') && BANNED_WORDS.includes('hostage'));
  for (const [k, tpl] of Object.entries(TEMPLATES)) {
    const txt = fill(tpl, VARS);
    assert.deepEqual(bannedHits(txt, PERSON_NAMES), [], `${k}: ${txt}`);
    assert.ok(!/\{\w+\}/.test(txt), `${k} left a placeholder: ${txt}`);
  }
  assert.deepEqual(bannedHits(DISCLAIMER), []);
  for (const r of STATUS_REASONS) assert.deepEqual(bannedHits(r), []);
});
test('every incident text says the crew is safe or evacuated safely', () => {
  for (const k of CREW) assert.match(fill(TEMPLATES[k], VARS), /Crew safe|evacuated safely/, k);
});
test('engine output in a full incident run stays within the templates', () => {
  const { pol, game } = makePolitics(), p = at(player({ home: 'hc1' }), 44, 30);
  game.rolls = [0.0001, 0.7, 0.9];
  pol.stepSea(p, 1);
  game.rolls = [0.99]; pol.incident(p, p, pol.ds.areaById.war4, 'mine');
  for (const e of game.events) assert.deepEqual(bannedHits(e.text, PERSON_NAMES), [], e.text);
  for (const s of game.sunk) assert.match(s.text, /All crew evacuated safely\.$/);
});
test("'regime' is banned in prose but the JSON key `regimes` is fine", () => {
  assert.deepEqual(bannedHits('the sanctions regime'), ['regime']);
  assert.deepEqual(bannedHits('regimes'), []);
});
test('the shipped dataset prose has no banned words or person names', () => {
  const parts = readParts();
  const hits = proseStrings(parts).map((s) => ({ ...s, h: bannedHits(s.text, PERSON_NAMES) })).filter((s) => s.h.length);
  assert.deepEqual(hits, []);
});
