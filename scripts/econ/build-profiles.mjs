#!/usr/bin/env node
// Refresh the country make/need tiers from a CEPII BACI file (docs/WORLD-ECONOMY-CONTRACT.md §5.5). Optional,
// maintainer-run; the seed shared/econ/countries.json is hand-curated and this script only proposes a diff.
//
//   node scripts/econ/build-profiles.mjs --baci BACI_HS17_Y2023_V202501.csv --codes country_codes_V202501.csv [--out diff.json] [--force]
//
// BACI rows: t (year), i (exporter code), j (importer code), k (HS6), v (value, kUSD), q (tonnes). Goods map through
// catalogue `hs` prefixes. Tiers: make 1 = export share ≥ 10 % or rank ≤ 3; make 2 = 3–10 %; make 3 = 1–3 % with
// exports > imports. need 1 = import share ≥ 5 %; need 2 = 2–5 %; need 3 = a net importer otherwise. Rows with
// basis 'source' are never overwritten without --force.
import fs from 'node:fs';
import readline from 'node:readline';
import { CATALOGUE } from '../../shared/econ/catalogue.js';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const baci = arg('--baci'), codes = arg('--codes'), out = arg('--out'), force = process.argv.includes('--force');
if (!baci || !codes) { console.error('usage: build-profiles.mjs --baci <BACI csv> --codes <country_codes csv> [--out diff.json] [--force]'); process.exit(2); }

/** Numeric BACI code → ISO2 (country_codes file: country_code, country_name, country_iso2, country_iso3). */
function readCodes(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/), head = lines.shift().split(',').map((s) => s.trim().replace(/"/g, ''));
  const ci = head.indexOf('country_code'), i2 = head.indexOf('country_iso2'), map = new Map();
  for (const l of lines) { const c = l.split(','); if (c[ci] && c[i2]) map.set(c[ci].trim(), c[i2].replace(/"/g, '').trim()); }
  return map;
}
/** HS6 → catalogue good by the longest matching `hs` prefix. */
function hsIndex() { const rows = []; for (const r of CATALOGUE) for (const p of r.hs) rows.push([p, r.id]); rows.sort((a, b) => b[0].length - a[0].length); return (k) => { for (const [p, g] of rows) if (k.startsWith(p)) return g; return null; }; }

export function tiersFrom(flows) {
  // flows: Map good → { exp: Map cc → value, imp: Map cc → value }
  const make = {}, need = {};
  for (const [g, f] of flows) {
    const te = [...f.exp.values()].reduce((a, b) => a + b, 0), ti = [...f.imp.values()].reduce((a, b) => a + b, 0);
    const ranked = [...f.exp.entries()].sort((a, b) => b[1] - a[1]);
    ranked.forEach(([cc, v], rank) => {
      const sh = te > 0 ? v / te : 0, imp = f.imp.get(cc) || 0;
      const tier = sh >= 0.10 || rank < 3 ? 1 : sh >= 0.03 ? 2 : sh >= 0.01 && v > imp ? 3 : 0;
      if (tier) (make[cc] ||= {})[g] = tier;
    });
    for (const [cc, v] of f.imp) {
      if (make[cc]?.[g]) continue;
      const sh = ti > 0 ? v / ti : 0, ex = f.exp.get(cc) || 0;
      const tier = sh >= 0.05 ? 1 : sh >= 0.02 ? 2 : v > ex ? 3 : 0;
      if (tier) (need[cc] ||= {})[g] = tier;
    }
  }
  return { make, need };
}

async function main() {
  const iso = readCodes(codes), goodOf = hsIndex(), flows = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(baci) });
  let head = null, n = 0;
  for await (const line of rl) {
    if (!head) { head = line.split(',').map((s) => s.trim()); continue; }
    const c = line.split(','), k = String(c[head.indexOf('k')]).padStart(6, '0'), g = goodOf(k); if (!g) continue;
    const ex = iso.get(c[head.indexOf('i')]), im = iso.get(c[head.indexOf('j')]), v = Number(c[head.indexOf('v')]);
    if (!ex || !im || !(v > 0)) continue;
    let f = flows.get(g); if (!f) flows.set(g, f = { exp: new Map(), imp: new Map() });
    f.exp.set(ex, (f.exp.get(ex) || 0) + v); f.imp.set(im, (f.imp.get(im) || 0) + v); n++;
  }
  const { make, need } = tiersFrom(flows);
  const cur = JSON.parse(fs.readFileSync(new URL('../../shared/econ/countries.json', import.meta.url), 'utf8'));
  const diff = {};
  for (const cc of new Set([...Object.keys(make), ...Object.keys(need)])) {
    const row = cur[cc]; if (!row) continue;   // only harbour countries have profiles
    if (row.basis === 'source' && !force) continue;
    const d = { make: {}, need: {} };
    for (const [g, t] of Object.entries(make[cc] || {})) if (row.make?.[g] !== t) d.make[g] = [row.make?.[g] ?? null, t];
    for (const [g, t] of Object.entries(need[cc] || {})) if (row.need?.[g] !== t) d.need[g] = [row.need?.[g] ?? null, t];
    if (Object.keys(d.make).length || Object.keys(d.need).length) diff[cc] = d;
  }
  const text = JSON.stringify({ rows: n, src: 'cepii-baci', diff }, null, 1);
  if (out) fs.writeFileSync(out, text); else console.log(text);
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main().catch((e) => { console.error(e.message); process.exit(1); });
