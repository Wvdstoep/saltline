#!/usr/bin/env node
// Reproduces Appendix A of docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md from shared/ships/catalogue.js.
//   node scripts/ships/gen-catalogue.mjs           print the table (Markdown)
//   node scripts/ships/gen-catalogue.mjs --check   compare every game column with the contract's Appendix A; exit 1 on a mismatch
import fs from 'node:fs';
import { MODELS, SAIL_IDS, admiralty } from '../../shared/ships/catalogue.js';

const fmt = (n) => (n == null ? '—' : typeof n === 'number' ? n.toLocaleString('en-US') : n);
const TYPE_LABEL = { motor_yacht: 'motor yacht' };

export function rows() {
  return Object.values(MODELS).filter((m) => !SAIL_IDS.includes(m.id)).map((m) => {
    const leg = m.era === 'classic';
    return {
      id: m.id, type: m.type, legacy: leg, name: m.refName, dims: `${m.length}×${m.beam}×${m.draft}`, dwt: m.dwt, gt: m.gt, cap: m.capText,
      kn: `${m.maxKn}/${m.svcKn}`, eng: `${fmt(m.kW)} · ${m.engine.label}`, sfoc: m.sfoc, burn: m.burn, fuel: m.fuelCap, crew: `${m.crew.min}/${m.crew.opt}`,
      usd: m.usdM, price: m.price || m.basis || 0, gameCap: m.capacity, disp: m.displacement, crewCost: m.crewCost, turn: m.turnRate,
      cadm: leg ? null : admiralty(m.displacement, m.maxKn, m.kW),
    };
  });
}

export function table() {
  const out = ['| id | Model | LOA×B×T m | DWT | GT | Capacity (real) | kn max/svc | kW · engine | sfoc | burn t/h | fuel t | crew min/opt | ref. newbuild USD m | **game price cr** | game cap t | Δ t | crewCost | turn | Cadm |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  let last = '';
  for (const r of rows()) {
    if (r.type !== last) { out.push(`| **${TYPE_LABEL[r.type] || r.type}** |||||||||||||||||||`); last = r.type; }
    out.push(`| \`${r.id}\`${r.legacy ? ' ⓛ' : ''} | ${r.name} | ${r.dims} | ${fmt(r.dwt)} | ${fmt(r.gt)} | ${r.cap} | ${r.kn} | ${r.eng} | ${r.sfoc} | ${r.burn} | ${fmt(r.fuel)} | ${r.crew} | ${r.usd} | **${fmt(r.price)}** | ${fmt(r.gameCap)} | ${fmt(r.disp)} | ${r.crewCost} | ${r.turn} | ${fmt(r.cadm)} |`);
  }
  return out.join('\n');
}

/** Parse Appendix A of the contract → { id: { burn, fuel, price, cap, disp, crewCost, turn } }. */
export function appendixA(file = new URL('../../docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md', import.meta.url)) {
  const txt = fs.readFileSync(file, 'utf8'), at = txt.indexOf('## Appendix A');
  const num = (s) => Number(String(s).replace(/[*,]/g, '').trim());
  const out = {};
  for (const line of txt.slice(at).split('\n')) {
    const m = /^\| `([a-z0-9_]+)`/.exec(line); if (!m) continue;
    const c = line.split('|').map((x) => x.trim());
    out[m[1]] = { burn: num(c[10]), fuel: num(c[11]), price: num(c[14]), cap: num(c[15]), disp: num(c[16]), crewCost: num(c[17]), turn: num(c[18]) };
  }
  return out;
}

export function check() {
  const ref = appendixA(), bad = [];
  for (const r of rows()) {
    const a = ref[r.id]; if (!a) { bad.push(`${r.id}: not in Appendix A`); continue; }
    if (r.legacy) continue;   // legacy rows: game columns are today's constants (deep-equal test), Appendix shows reference values
    for (const [k, v] of [['burn', r.burn], ['fuel', r.fuel], ['price', r.price], ['cap', r.gameCap], ['disp', r.disp], ['crewCost', r.crewCost], ['turn', r.turn]]) {
      if (Math.abs(a[k] - v) > 1e-9) bad.push(`${r.id}.${k}: catalogue ${v}, Appendix A ${a[k]}`);
    }
  }
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--check')) {
    const bad = check();
    if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
    console.log(`Appendix A reproduced: ${rows().length} rows.`);
  } else console.log(table());
}
