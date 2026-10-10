#!/usr/bin/env node
// World economy dataset validator (docs/WORLD-ECONOMY-CONTRACT.md §5, §17). Exits 0 when the data is consistent, 1 with
// one line per problem otherwise. `--dir <dir>` reads countries.json / sites.json / sources.json from another folder
// (fixtures); the catalogue, seasons and chains always come from shared/econ/*.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE, baseFor, LEGACY_GOODS } from '../../shared/econ/catalogue.js';
import { SEASONS } from '../../shared/econ/seasons.js';
import { CHAINS } from '../../shared/econ/chains.js';
import { CARGO, HANDLING, UNITS } from '../../shared/cargo.js';
import { loadEcon, listingOf } from '../../shared/econ/model.js';
import { HARBORS } from '../../server/harbors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '../../shared/econ');
const LEGACY_BASE = { fish: 700, grain: 260, steel: 900, machinery: 3200, containers: 2100, fuel: 650, supplies: 1800 };
const REGIONS = ['eu', 'med', 'mena', 'ssa', 'sasia', 'easia', 'sea', 'oceania_island', 'latam', 'nam', 'arctic'];

/** → [problem strings] (empty = valid). */
export function validate({ countries, sites, sources, harbors = HARBORS }) {
  const errs = [], goods = new Set(CATALOGUE.map((r) => r.id)), hIds = new Set(harbors.map((h) => h.id));
  const seen = new Set();
  for (const r of CATALOGUE) {
    if (seen.has(r.id)) errs.push(`catalogue: duplicate id ${r.id}`); seen.add(r.id);
    if (!CARGO[r.id] || CARGO[r.id].market !== true) errs.push(`catalogue: ${r.id} has no market CARGO row`);
    for (const o of r.opts) if (!HANDLING[o.h]) errs.push(`catalogue: ${r.id} handling ${o.h} unknown`);
    if (!UNITS[r.unit]) errs.push(`catalogue: ${r.id} unit ${r.unit} unknown`);
    if (LEGACY_BASE[r.id] != null ? r.base !== LEGACY_BASE[r.id] : r.base !== baseFor(r.refUsdT)) errs.push(`catalogue: ${r.id} base ${r.base} breaks the §4.1 rule`);
  }
  for (const g of LEGACY_GOODS) if (!goods.has(g)) errs.push(`catalogue: legacy good ${g} missing`);
  const tpl = countries?._templates || {};
  for (const [reg, t] of Object.entries(tpl)) {
    if (!REGIONS.includes(reg)) errs.push(`template ${reg}: unknown region`);
    for (const g of [...Object.keys(t.make || {}), ...Object.keys(t.need || {})]) if (!goods.has(g)) errs.push(`template ${reg}: unknown good ${g}`);
  }
  for (const [cc, row] of Object.entries(countries || {})) {
    if (cc === '_templates') continue;
    if (!REGIONS.includes(row.region)) errs.push(`${cc}: region ${row.region} unknown`);
    for (const k of ['make', 'need']) for (const [g, t] of Object.entries(row[k] || {})) {
      if (!goods.has(g)) errs.push(`${cc}: unknown good ${g} in ${k}`);
      if (![1, 2, 3].includes(t)) errs.push(`${cc}: ${k}.${g} tier ${t} not 1–3`);
    }
    for (const g of Object.keys(row.make || {})) if (row.need && g in row.need) errs.push(`${cc}: ${g} is both made and needed`);
    for (const g of row.hub || []) { if (!goods.has(g)) errs.push(`${cc}: unknown hub good ${g}`); if (g in (row.make || {}) || g in (row.need || {})) errs.push(`${cc}: hub good ${g} also made or needed`); }
    for (const s of row.src || []) if (!sources?.[s]) errs.push(`${cc}: source ${s} not in sources.json`);
    if (!['source', 'game'].includes(row.basis)) errs.push(`${cc}: basis ${row.basis}`);
    if (!row.asOf) errs.push(`${cc}: asOf missing`);
  }
  for (const cc of new Set(harbors.map((h) => h.country))) if (!countries?.[cc]) errs.push(`${cc}: harbour country without a profile row`);
  for (const s of sites?.sites || []) {
    if (!hIds.has(s.harbor)) errs.push(`site ${s.id}: harbour ${s.harbor} unknown`);
    const c = CHAINS[s.chain];
    if (!c) { errs.push(`site ${s.id}: chain ${s.chain} unknown`); continue; }
    if (![1, 2, 3].includes(s.cap)) errs.push(`site ${s.id}: cap ${s.cap} not 1–3`);
    for (const s2 of s.src || []) if (!sources?.[s2]) errs.push(`site ${s.id}: source ${s2} not in sources.json`);
  }
  for (const [id, c] of Object.entries(CHAINS)) for (const g of [c.main, ...Object.keys(c.inputs), ...Object.keys(c.co || {})]) if (!goods.has(g)) errs.push(`chain ${id}: unknown good ${g}`);
  for (const [g, ids] of Object.entries(sites?.exportVia || {})) {
    if (!goods.has(g)) errs.push(`exportVia: unknown good ${g}`);
    for (const id of ids) if (!hIds.has(id)) errs.push(`exportVia ${g}: harbour ${id} unknown`);
  }
  for (const s of SEASONS) if (!goods.has(s.good)) errs.push(`season: unknown good ${s.good}`);
  if (!errs.length) {
    const eds = loadEcon({ countries, sites, seasons: SEASONS, chains: CHAINS });
    for (const h of harbors) { const l = listingOf(eds, h); if (l.length > 32) errs.push(`${h.id}: lists ${l.length} goods (> 32)`); if (!l.includes('fuel')) errs.push(`${h.id}: does not list fuel`); }
  }
  return errs;
}

export function readDir(dir) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(fs.existsSync(path.join(dir, f)) ? dir : DATA, f), 'utf8'));
  return { countries: read('countries.json'), sites: read('sites.json'), sources: read('sources.json') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--dir'), dir = i > 0 ? process.argv[i + 1] : DATA;
  let errs;
  try { errs = validate(readDir(dir)); } catch (e) { errs = [`unreadable: ${e.message}`]; }
  if (errs.length) { for (const e of errs) console.log(e); process.exit(1); }
  console.log(`econ data ok: ${CATALOGUE.length} goods, ${Object.keys(readDir(dir).countries).length - 1} countries`);
  process.exit(0);
}
