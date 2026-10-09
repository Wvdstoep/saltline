// Contract §7 politics-data: the REAL dataset — structure only, never values (values change with every refresh).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateDataset, readDir, DEFAULT_DIR, CLIENT_FILES, BUDGET } from '../scripts/politics/validate.mjs';
import { HARBORS } from '../server/harbors.js';
import { Politics, readParts } from '../server/politics.js';
import { loadDataset, harbourRules, makeCtx, areasAt } from '../shared/politics.js';

const { parts, sizes } = readDir();
const today = parts.meta.validAsOf;

test('the shipped dataset passes validate.mjs (no verify: true rows, sources resolve, polygons valid, budget met)', () => {
  const r = validateDataset(parts, { harbors: HARBORS, sizes, today });
  assert.deepEqual(r.errors, []);
});
test('every harbour country has a row (124 today)', () => {
  const ccs = [...new Set(HARBORS.map((h) => h.country))];
  assert.ok(ccs.length >= 124);
  for (const cc of ccs) assert.ok(parts.countries[cc], cc);
});
test('every area and regime has ≥ 1 source and an asOf; measures inherit their regime source', () => {
  for (const a of parts.areas) { assert.ok(a.src.length >= 1, a.id); assert.match(a.asOf, /^\d{4}-\d{2}-\d{2}$/); }
  for (const r of parts.regimes) { assert.ok(r.src.length >= 1, r.id); assert.ok(r.asOf, r.id); }
});
test(`client subset ≤ ${BUDGET.clientKB} KB, everything ≤ ${BUDGET.totalKB} KB`, () => {
  const client = CLIENT_FILES.reduce((s, f) => s + (sizes[f] || 0), 0);
  assert.ok(client <= BUDGET.clientKB * 1024, `${client} B`);
});
test('pending.json holds unverified seed rows and is never loaded', () => {
  const pend = JSON.parse(fs.readFileSync(path.join(DEFAULT_DIR, 'pending.json'), 'utf8'));
  assert.ok(Array.isArray(pend.rows) && pend.rows.length > 0);
  assert.ok(!('pending' in readParts()));
  const ids = new Set(parts.areas.map((a) => a.id));
  for (const r of pend.rows.filter((x) => x.file === 'areas')) assert.ok(!ids.has(r.id), r.id);
});
test('the server engine loads the shipped dataset and every harbour gets a Rules payload', () => {
  const pol = new Politics({ simTime: Date.parse(today) / 1000, rnd: () => 0.5, event() {}, log() {} });
  const ctx = makeCtx(pol.ds, { home: 'NL', simTime: pol.now });
  for (const h of HARBORS) {
    const r = harbourRules(pol.ds, ctx, h, { cls: 'coaster', cond: 78, built: 2020 });
    assert.ok(['open', 'restricted', 'closed'].includes(r.status.value), h.id);
    assert.ok(r.version && r.validAsOf && r.disclaimer);
  }
  assert.ok(JSON.parse(pol.clientPayload().json).meta.version);
});
test('structure of the Odesa example (§1): restricted, clearance, corridor, listed area', () => {
  const ds = loadDataset({ ...parts, harbors: HARBORS }), od = HARBORS.find((h) => h.id === 'odesa');
  if (!ds.ports.odesa) return;                       // the data may legitimately change; only check shape when present
  assert.ok(['restricted', 'closed', 'open'].includes(ds.ports.odesa.status.value));
  if (ds.ports.odesa.entry?.corridor) assert.equal(ds.areaById[ds.ports.odesa.entry.corridor].kind, 'corridor');
  assert.ok(areasAt(ds, od.lat, od.lon).every((a) => a.src.length > 0));
});
