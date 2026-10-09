// Shared helpers for test/politics-*.test.mjs (not a test file itself). Every rule test runs on the fixture dataset
// in test/fixtures/politics (fake countries XA–XH, square areas), so refreshing the real data never changes them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, makeCtx } from '../shared/politics.js';
import { Politics, readParts } from '../server/politics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIX = path.join(HERE, 'fixtures/politics');
export const T0 = Date.UTC(2026, 9, 8, 12, 0, 0) / 1000;   // Thu 2026-10-08 12:00 UTC
export function fixtureParts() {
  const parts = readParts(FIX);
  return { ...parts, harbors: JSON.parse(fs.readFileSync(path.join(FIX, 'harbors.json'), 'utf8')) };
}
export function fixtureDs() { return loadDataset(fixtureParts()); }
export function ctxFor(ds, o = {}) { return makeCtx(ds, { simTime: T0, ...o }); }

export class FakeGame {
  constructor(t = T0) {
    this.simTime = t; this.rolls = []; this.events = []; this.sunk = []; this.sent = []; this.impounded = [];
    this.harbors = { ha1: { market: { steel: 900, fuel: 650, fish: 1000, grain: 300 } }, hd1: { market: { steel: 900 } } };
    this.log = () => {};
  }
  rnd() { return this.rolls.length ? this.rolls.shift() : 0.999; }
  event(p, kind, text) { this.events.push({ kind, text }); }
  sink(p, reason, text) { this.sunk.push({ reason, text }); }
  send(p, m) { this.sent.push(m); }
  impound(p, by, fine) { this.impounded.push({ by, fine }); }
}
export function makePolitics(game = new FakeGame()) {
  const parts = fixtureParts();
  return { game, pol: new Politics(game, { dataset: loadDataset(parts), harbors: parts.harbors }) };
}
/** A plain player that is its own vessel (no v6 fleet), as the engine supports for tests and legacy callers. */
export function player(o = {}) {
  return {
    id: o.id || 'p1', name: o.name || 'Sea Lark', money: o.money ?? 1000000, office: { home: o.home ?? 'ha1' },
    ship: { cls: o.cls ?? 'coaster', lat: o.lat ?? 50, lon: o.lon ?? 0, spd: o.spd ?? 10 },
    cond: o.cond ?? 78, cargo: o.cargo ?? [], jobs: o.jobs ?? [],
  };
}
export function at(p, lat, lon) { p.ship.lat = lat; p.ship.lon = lon; return p; }
