#!/usr/bin/env node
// Condense a CEPII BACI file (HS6 bilateral flows, from UN Comtrade) into shared/politics/trade.json
// (docs/WORLD-POLITICS-CONTRACT.md §3.10). Streams line by line, no dependencies.
//   node scripts/politics/build-trade.mjs <BACI_HSxx_Yyyyy_V2025xx.csv> --codes <country_codes_V2025xx.csv> [--year 2023] [--out shared/politics/trade.json]
// BACI columns: t (year), i (exporter code), j (importer code), k (HS6), v (value, thousand USD), q (tonnes).
// The country-codes file maps BACI numeric codes → ISO alpha-2 (columns country_code, country_iso2).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOP_N = 8;
/** HS6 code → game good (null = not mapped). */
export function goodOfHs(k) {
  const s = String(k).padStart(6, '0'), ch = +s.slice(0, 2), h4 = s.slice(0, 4);
  if (ch === 10 || ch === 11 || h4 === '1201') return 'grain';
  if (ch === 3 || h4 === '1604' || h4 === '1605') return 'fish';
  if (ch === 72 || ch === 73) return 'steel';
  if (ch === 84 || ch === 85) return 'machinery';
  if (ch === 27) return 'fuel';
  if (ch === 39 || ch === 40 || (ch >= 61 && ch <= 64) || (ch >= 94 && ch <= 96)) return 'containers';
  return null;
}
function splitCsv(line) { return line.split(',').map((x) => x.replace(/^"|"$/g, '').trim()); }
export async function readCodes(file) {
  const map = new Map(); let head = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const c = splitCsv(line);
    if (!head) { head = c.map((x) => x.toLowerCase()); continue; }
    const code = c[head.indexOf('country_code')], iso2 = c[head.indexOf('country_iso2')];
    if (code && /^[A-Z]{2}$/.test(iso2 || '')) map.set(String(+code), iso2);
  }
  return map;
}
/** Aggregate an iterable of CSV lines (header first). Returns { year, flows } with USD m values. */
export async function condense(lines, codes, { year = null } = {}) {
  const exp = new Map(), imp = new Map(), pair = new Map();   // key `${cc}|${good}` / `${i}|${good}|${j}`
  let head = null, yr = year;
  for await (const line of lines) {
    if (!line || !line.trim()) continue;
    const c = splitCsv(line);
    if (!head) { head = c.map((x) => x.toLowerCase()); continue; }
    const t = +c[head.indexOf('t')], i = codes.get(String(+c[head.indexOf('i')])), j = codes.get(String(+c[head.indexOf('j')]));
    if (yr != null && t !== yr) continue; if (yr == null) yr = t;
    const g = goodOfHs(c[head.indexOf('k')]), v = +c[head.indexOf('v')] / 1000;
    if (!g || !i || !j || !(v > 0)) continue;
    exp.set(`${i}|${g}`, (exp.get(`${i}|${g}`) || 0) + v);
    imp.set(`${j}|${g}`, (imp.get(`${j}|${g}`) || 0) + v);
    pair.set(`${i}|${g}|${j}`, (pair.get(`${i}|${g}|${j}`) || 0) + v);
  }
  const flows = {};
  const r1 = (x) => Math.round(x * 10) / 10;
  for (const key of new Set([...exp.keys(), ...imp.keys()])) {
    const [cc, g] = key.split('|');
    (flows[cc] ||= {})[g] = { exp: r1(exp.get(key) || 0), imp: r1(imp.get(key) || 0), top: [] };
  }
  const tops = new Map();
  for (const [key, v] of pair) { const [i, g, j] = key.split('|'); const k = `${i}|${g}`; if (!tops.has(k)) tops.set(k, []); tops.get(k).push([j, v]); }
  for (const [k, list] of tops) {
    const [i, g] = k.split('|'), tot = exp.get(k) || 1;
    flows[i][g].top = list.sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([j, v]) => [j, Math.round((v / tot) * 1000) / 1000]);
  }
  return { year: yr, flows };
}
export function movers(prev, next, n = 10) {
  const out = [];
  for (const [cc, gs] of Object.entries(next.flows || {})) for (const [g, f] of Object.entries(gs)) {
    const p = prev?.flows?.[cc]?.[g]; if (!p) continue;
    const d = (f.exp - f.imp) - (p.exp - p.imp); out.push({ cc, g, d });
  }
  return out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, n);
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--codes' && args[args.indexOf(a) - 1] !== '--year' && args[args.indexOf(a) - 1] !== '--out');
  if (!file || !opt('--codes')) { console.log('usage: build-trade.mjs <baci.csv> --codes <country_codes.csv> [--year 2023] [--out shared/politics/trade.json]'); process.exit(2); }
  const out = path.resolve(opt('--out') || path.join(HERE, '../../shared/politics/trade.json'));
  const codes = await readCodes(opt('--codes'));
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const res = await condense(rl, codes, { year: opt('--year') ? +opt('--year') : null });
  const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  const doc = { year: res.year, unit: 'USD m', src: ['cepii-baci'], asOf: new Date().toISOString().slice(0, 10), flows: res.flows };
  fs.writeFileSync(out, JSON.stringify(doc) + '\n');
  console.log(`[politics] trade.json: ${Object.keys(res.flows).length} countries, year ${res.year}, ${Math.round(fs.statSync(out).size / 1024)} KB`);
  for (const m of movers(prev, doc)) console.log(`  ${m.cc} ${m.g}: net exports ${m.d > 0 ? '+' : ''}${m.d.toFixed(0)} USD m`);
  console.log('Add a "cepii-baci" entry to sources.json (title, url, published) if it is not there yet, then run validate.mjs.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
