#!/usr/bin/env node
// Data-lane checks for the ship catalogue and the yards (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §2, §3).
//   node scripts/ships/validate.mjs            → summary; exit 1 on an error
//   node scripts/ships/validate.mjs --verify   → also list every row still flagged `verify: true` (to be checked against §13)
import { MODELS, admiralty } from '../../shared/ships/catalogue.js';
import { YARDS, YARD_IDS, YARD_COUNTRIES, CAP_TAGS } from '../../shared/ships/yards.js';
import { registerHarbors, yardsFor } from '../../shared/ships/index.js';
import { HARBORS, harborById } from '../../server/harbors.js';
import { check as appendixCheck } from './gen-catalogue.mjs';

registerHarbors(HARBORS);
const errors = [], warnings = [];
for (const e of appendixCheck()) errors.push(`Appendix A: ${e}`);
const offered = new Set(YARD_IDS.flatMap((id) => YARDS[id].builds));
for (const m of Object.values(MODELS)) {
  if (!CAP_TAGS.includes(m.builders[0])) errors.push(`${m.id}: unknown builder tag ${m.builders[0]}`);
  if (!offered.has(m.builders[0])) errors.push(`${m.id}: no yard builds ${m.builders[0]}`);
  if (!yardsFor(m.id).length) errors.push(`${m.id}: no yard can take an order`);
  if (m.era === 'eco' && m.length >= 100 && m.Cb) {
    const c = admiralty(m.displacement, m.maxKn, m.kW);
    if (c < 300 || c > 1000) warnings.push(`${m.id}: Admiralty coefficient ${c} outside 300–1,000 (check kW / speed)`);
  }
}
for (const id of YARD_IDS) {
  const y = YARDS[id], h = harborById(y.harbor);
  if (!h) errors.push(`${id}: harbour ${y.harbor} missing`);
  else if (h.country !== y.cc) errors.push(`${id}: harbour ${h.id} is in ${h.country}, yard in ${y.cc}`);
  if (!YARD_COUNTRIES[y.cc]) errors.push(`${id}: no country row ${y.cc}`);
}
console.log(`${Object.keys(MODELS).length} models, ${YARD_IDS.length} yards, ${Object.keys(YARD_COUNTRIES).length} builder countries.`);
for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
if (process.argv.includes('--verify')) {
  const mv = Object.values(MODELS).filter((m) => m.verify).map((m) => m.id), yv = YARD_IDS.filter((id) => YARDS[id].verify);
  console.log(`verify: ${mv.length} models, ${yv.length} yards still flagged.\n  models: ${mv.join(', ')}\n  yards: ${yv.join(', ')}`);
}
process.exit(errors.length ? 1 : 0);
