// World economy, Lane A: the data files (docs/WORLD-ECONOMY-CONTRACT.md §4, §5, §17 econ-data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOGUE, CATS, baseFor, catalogueOf } from '../shared/econ/catalogue.js';
import { CARGO, HANDLING, UNITS, marketGoodOf } from '../shared/cargo.js';
import { GOODS } from '../shared/constants.js';
import { roleOf, listingOf, normalOf, flowsOf, profileOf } from '../shared/econ/model.js';
import { econDataset, econParts, readJson } from '../server/econdata.js';
import { HARBORS, harborById } from '../server/harbors.js';
import { validate, readDir } from '../scripts/econ/validate.mjs';
import { goodsMatch } from '../shared/politics.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const eds = econDataset();
const H = (id) => harborById(id);

test('catalogue: 80 market goods, each with a market CARGO row, known handling and unit; legacy bases kept', () => {
  assert.equal(CATALOGUE.length, 80);
  assert.equal(new Set(CATALOGUE.map((r) => r.id)).size, 80);
  for (const r of CATALOGUE) {
    assert.ok(CARGO[r.id] && CARGO[r.id].market === true, r.id);
    for (const o of r.opts) assert.ok(HANDLING[o.h], `${r.id} ${o.h}`);
    assert.ok(UNITS[r.unit], `${r.id} ${r.unit}`);
    assert.ok(CATS.some((c) => c.id === r.cat), r.cat);
    assert.ok(GOODS[r.id] && GOODS[r.id].base === r.base && !GOODS[r.id].contraband, r.id);
  }
  assert.deepEqual(Object.fromEntries(['fish', 'grain', 'steel', 'machinery', 'containers', 'fuel', 'supplies'].map((g) => [g, catalogueOf(g).base])),
    { fish: 700, grain: 260, steel: 900, machinery: 3200, containers: 2100, fuel: 650, supplies: 1800 });
  assert.equal(GOODS.grain.name, 'Grain'); assert.equal(GOODS.fuel.name, 'Bunker fuel');   // legacy rows identical
  for (const c of ['cigarettes', 'weapons', 'narcotics', 'antiquities']) assert.ok(GOODS[c].contraband && !catalogueOf(c));
  assert.equal(marketGoodOf('fruit'), 'bananas'); assert.equal(CARGO.fruit.market, false);
  const counts = {}; for (const r of CATALOGUE) counts[r.cat] = (counts[r.cat] || 0) + 1;
  assert.deepEqual(counts, { grains: 8, fert: 3, ores: 10, energy: 11, gas: 3, reefer: 13, box: 17, breakbulk: 9, vehicles: 3, animals: 2, offshore: 1 });
});

test('base follows the §4.1 rule for every non-legacy row (5,500 → 2,345; 40,000 → 6,325; 60,000 → 7,746)', () => {
  assert.equal(baseFor(5500), 2345); assert.equal(baseFor(40000), 6325); assert.equal(baseFor(60000), 7746); assert.equal(baseFor(1000), 1000); assert.equal(baseFor(1e9), 8000);
  for (const r of CATALOGUE) if (!r.legacy) assert.equal(r.base, baseFor(r.refUsdT), r.id);
  assert.equal(catalogueOf('coffee').base, 2345); assert.equal(catalogueOf('electronics').base, 6325); assert.equal(catalogueOf('pharma').base, 7746);
});

test('every harbour country (124) resolves to a profile; no good both made and needed; sources resolve; sites and chains exist', () => {
  const countries = readJson('countries.json'), sources = readJson('sources.json'), sites = readJson('sites.json');
  const ccs = new Set(HARBORS.map((h) => h.country));
  assert.equal(ccs.size, 124);
  for (const cc of ccs) { assert.ok(countries[cc], cc); const p = profileOf(eds, cc); for (const g of Object.keys(p.make)) assert.ok(!(g in p.need), `${cc} ${g}`); }
  for (const [cc, row] of Object.entries(countries)) {
    if (cc === '_templates') continue;
    for (const s of row.src) assert.ok(sources[s], `${cc} ${s}`);
    assert.ok(row.asOf && ['source', 'game'].includes(row.basis) && typeof row.verify === 'boolean', cc);
  }
  for (const s of sites.sites) assert.ok(H(s.harbor), s.id);
  assert.ok(fs.statSync(path.join(ROOT, 'shared/econ/countries.json')).size <= 60 * 1024, 'countries.json ≤ 60 KB');
  assert.equal(countries.AU.until.sheep, '2028-05-01');
});

test('roles on the real data (§17)', () => {
  const r = (h, g) => roleOf(eds, H(h), g);
  assert.deepEqual([r('santos', 'coffee').role, r('santos', 'coffee').tier], ['P', 1]);
  assert.equal(r('rotterdam', 'coffee').role, 'I');
  assert.equal(r('port_hedland', 'ore').role, 'P');
  assert.equal(r('qingdao', 'ore').role, 'I');
  assert.equal(r('ras_laffan', 'lng').role, 'P');
  assert.equal(r('tokyo', 'lng').role, 'I');
  assert.equal(r('bergen', 'salmon').role, 'P');
  assert.equal(r('abidjan', 'cocoa').role, 'P');
  assert.equal(r('antofagasta', 'copper').role, 'P');
  assert.deepEqual([r('ijmuiden', 'ore').role, r('ijmuiden', 'ore').b, r('ijmuiden', 'ore').site], ['I', -0.45, 'steel']);
  assert.equal(r('ijmuiden', 'steel').role, 'P');
  assert.equal(r('santos', 'ore').role, 'L');            // Brazil ships ore from its ore terminals only
  assert.equal(r('singapore', 'containers').role, 'L');  // hub
  assert.equal(r('rotterdam', 'fuel').role, 'P');
  assert.equal(r('rotterdam', 'flowers').role, 'P');
  // IJmuiden steel worked example (§8.3)
  assert.equal(normalOf(eds, H('ijmuiden'), 'steel'), 11250);
  assert.equal(Math.round(flowsOf(eds, H('ijmuiden'), 'steel').P * 100) / 100, 363.75);
  assert.equal(normalOf(eds, H('ijmuiden'), 'ore'), 53889);
  assert.equal(normalOf(eds, H('ijmuiden'), 'cokingcoal'), 25260);
});

test('every harbour lists fuel and at most 32 goods; the mean listing is 20–32; legacy goods are never dropped', () => {
  let sum = 0;
  for (const h of HARBORS) {
    const l = listingOf(eds, h);
    assert.ok(l.includes('fuel'), h.id); assert.ok(l.length <= 32, `${h.id} ${l.length}`);
    for (const g of ['fish', 'grain', 'steel', 'machinery', 'containers']) assert.ok(l.includes(g), `${h.id} lists ${g}`);
    sum += l.length;
  }
  const mean = sum / HARBORS.length;
  assert.ok(mean >= 20 && mean <= 32, `mean ${mean.toFixed(1)}`);
  // every good is made somewhere except offshore supplies (traded near the platforms)
  const made = new Set(); for (const h of HARBORS) for (const g of listingOf(eds, h)) if (roleOf(eds, h, g).role === 'P') made.add(g);
  assert.deepEqual(CATALOGUE.map((r) => r.id).filter((g) => !made.has(g)), ['supplies']);
});

test('politics measures match new goods through polGroup (§9.3)', () => {
  const m = { goods: ['steel'] };
  assert.ok(goodsMatch(m, 'steel') && goodsMatch(m, 'pipes') && goodsMatch(m, 'ore') && goodsMatch(m, 'cokingcoal'));
  assert.ok(!goodsMatch(m, 'coffee'));
  assert.ok(goodsMatch({ goods: ['fuel'] }, 'crude') && goodsMatch({ goods: ['fuel'] }, 'lng') && goodsMatch({}, 'anything'));
});

test('the validator passes the repository data and fails each of 6 broken fixtures (exit codes)', () => {
  assert.deepEqual(validate(readDir(path.join(ROOT, 'shared/econ'))), []);
  const run = (dir) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/econ/validate.mjs'), ...(dir ? ['--dir', dir] : [])], { encoding: 'utf8' });
  assert.equal(run(null).status, 0);
  const base = readDir(path.join(ROOT, 'shared/econ'));
  const breakers = [
    (d) => { d.countries.BR.need.coffee = 2; },                      // made and needed
    (d) => { d.countries.NL.src.push('no-such-source'); },           // unknown source id
    (d) => { d.sites.sites[0].harbor = 'atlantis'; },                // site harbour unknown
    (d) => { d.sites.sites[1].chain = 'alchemy'; },                  // chain unknown
    (d) => { d.countries.CL.make.unobtainium = 1; },                 // good unknown
    (d) => { delete d.countries.BR; },                               // a harbour country without a row
  ];
  for (const [i, f] of breakers.entries()) {
    const d = structuredClone(base); f(d);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'econ-fixture-'));
    fs.writeFileSync(path.join(dir, 'countries.json'), JSON.stringify(d.countries));
    fs.writeFileSync(path.join(dir, 'sites.json'), JSON.stringify(d.sites));
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(d.sources));
    const r = run(dir);
    assert.equal(r.status, 1, `fixture ${i}: ${r.stdout}`);
    assert.ok(r.stdout.trim().length > 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the /api/econ/data parts are complete and browser-safe', () => {
  const p = econParts();
  assert.ok(p.catalogue.length === 80 && p.countries._templates && p.seasons.length > 10 && Object.keys(p.chains).length === 13 && p.sites.sites.length > 40);
});
