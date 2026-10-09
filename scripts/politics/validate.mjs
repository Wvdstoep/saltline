#!/usr/bin/env node
// Validate the world-politics dataset (docs/WORLD-POLITICS-CONTRACT.md §3.14). Node 20 built-ins only.
//   node scripts/politics/validate.mjs [--allow-unverified] [--dir shared/politics] [--harbors file.json] [--today YYYY-MM-DD]
// Exit code 1 on any error. Exports validateDataset() / readDir() for the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ringArea, ringSelfIntersects, loadDataset } from '../../shared/politics.js';
import { MID } from '../../server/ais/mid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIR = path.resolve(HERE, '../../shared/politics');
export const FILES = ['meta', 'sources', 'countries', 'ports', 'registries', 'regimes', 'areas', 'agreements', 'tariffs', 'psc', 'trade'];
export const CLIENT_FILES = FILES.filter((f) => f !== 'trade');
export const BUDGET = { totalKB: 400, clientKB: 150 };
// Words never allowed in data or templates (P3/P5). 'regime' is checked in prose only (the key `regimes` is fine).
export const BANNED_WORDS = ['enemy', 'aggressor', 'terrorist', 'regime', 'evil', 'heroic', 'glory', 'kill', 'dead', 'casualt', 'hostage', 'ransom', 'invader', 'liberat'];
export const MEASURE_KINDS = ['import_ban', 'export_ban', 'service_ban', 'port_ban', 'entry_lockout', 'tariff_add', 'secondary', 'arms_embargo'];
export const AREA_KINDS = ['war_risk', 'warlike', 'piracy', 'eca', 'corridor', 'warning'];
const ENFORCE = ['block', 'refuse_entry', 'seize_on_entry', 'designation'];
const GOODS_OK = ['grain', 'fish', 'steel', 'machinery', 'containers', 'fuel', 'supplies', 'weapons', 'cigarettes', 'narcotics', 'antiquities'];
const EXTRA_CC = ['IM', 'JE', 'GG', 'XK', 'GU', 'EU'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function readDir(dir = DEFAULT_DIR) {
  const parts = {}, sizes = {};
  for (const f of FILES) {
    const p = path.join(dir, `${f}.json`);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    sizes[f] = Buffer.byteLength(raw);
    parts[f] = JSON.parse(raw);
  }
  return { parts, sizes };
}
function walk(o, fn, at = '') {
  if (Array.isArray(o)) o.forEach((v, i) => walk(v, fn, `${at}[${i}]`));
  else if (o && typeof o === 'object') { fn(o, at); for (const [k, v] of Object.entries(o)) walk(v, fn, at ? `${at}.${k}` : k); }
}
/** Strings in the dataset that are prose (not keys, ids, urls). */
export function proseStrings(parts) {
  const out = [];
  const skip = new Set(['id', 'src', 'url', 'regimeId', 'measureId', 'areaId', 'bloc', 'psc', 'register', 'customs', 'corridor', 'kind', 'rule', 'enforce', 'scope']);
  walk(parts, (o, at) => { for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && !skip.has(k)) out.push({ at: `${at}.${k}`, text: v }); });
  return out;
}
export function bannedHits(text, extra = []) {
  const t = String(text).toLowerCase(), hits = [];
  for (const w of BANNED_WORDS) {
    if (w === 'regime') { if (/\bregime\b/.test(t)) hits.push(w); continue; }
    if (t.includes(w)) hits.push(w);
  }
  // names (extra list): whole words only, so 'modi' hits neither 'commodity' nor 'modified'
  for (const w of extra) if (new RegExp(`(^|[^\\p{L}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(t)) hits.push(w);
  return hits;
}

export function validateDataset(parts, { harbors = [], allowUnverified = false, today = new Date().toISOString().slice(0, 10), sizes = null } = {}) {
  const errors = [], warn = [];
  const err = (m) => errors.push(m);
  const { meta = {}, sources = {}, countries = {}, ports = {}, registries = {}, regimes = [], areas = [], agreements = [], tariffs = {}, psc = { regimes: {} }, trade = null } = parts;
  const known = new Set([...MID.values(), ...EXTRA_CC]);
  const isCc = (c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c) && known.has(c);
  // meta
  if (meta.schema !== 1) err('meta.schema must be 1');
  if (!/^\d{4}\.\d{2}\.\d+$/.test(meta.version || '')) err(`meta.version "${meta.version}" is not YYYY.MM.n`);
  if (!ISO.test(meta.validAsOf || '')) err('meta.validAsOf must be an ISO date');
  // sources
  for (const [id, s] of Object.entries(sources)) {
    if (!/^[a-z0-9-]{3,48}$/.test(id)) err(`sources.${id}: bad id`);
    if (!s.title || !s.publisher) err(`sources.${id}: title and publisher required`);
    if (s.kind !== 'game' && !/^https?:\/\//.test(s.url || '')) err(`sources.${id}: url required`);
    if (s.published && !ISO.test(s.published)) err(`sources.${id}: published not ISO`);
  }
  // generic record checks
  const checkRec = (rec, at, { needSrc = true } = {}) => {
    if (!rec || typeof rec !== 'object') return;
    if (needSrc) {
      if (!Array.isArray(rec.src) || !rec.src.length) err(`${at}: src (≥ 1 source id) required`);
      if (!ISO.test(rec.asOf || '')) err(`${at}: asOf (ISO date) required`);
    }
    for (const s of rec.src || []) if (!sources[s]) err(`${at}: unknown source "${s}"`);
    for (const k of ['asOf', 'reviewBy', 'from', 'until']) if (rec[k] != null && !ISO.test(rec[k])) err(`${at}.${k}: "${rec[k]}" is not an ISO date`);
    if (rec.asOf && rec.asOf > today) err(`${at}: asOf ${rec.asOf} is in the future`);
    if (rec.basis && !['source', 'game'].includes(rec.basis)) err(`${at}: basis must be source|game`);
    if (rec.note && rec.note.length > 280) err(`${at}: note longer than 280 chars`);
  };
  walk(parts, (o, at) => {
    if (o.verify === true && !allowUnverified) err(`${at}: verify: true (unverified seed row)`);
    if ('person' in o || 'persons' in o) err(`${at}: person fields are not allowed (P6)`);
    if (Array.isArray(o.src)) for (const s of o.src) if (!sources[s]) err(`${at}: unknown source "${s}"`);
  });
  // countries
  const harbourCc = [...new Set(harbors.map((h) => h.country))];
  for (const cc of harbourCc) if (!countries[cc]) err(`countries: no row for harbour country ${cc}`);
  const agIds = new Set(agreements.map((a) => a.id));
  for (const [cc, c] of Object.entries(countries)) {
    const at = `countries.${cc}`;
    if (!isCc(cc)) err(`${at}: unknown ISO code`);
    checkRec(c, at);
    if (!c.name) err(`${at}: name required`);
    if (c.customs && !agIds.has(c.customs) && !isCc(c.customs)) err(`${at}: customs "${c.customs}" is neither an agreement id nor a country code`);
    if (!Array.isArray(c.follows) || !c.follows.includes('UN')) err(`${at}: follows must include UN`);
    if (c.psc != null && !psc.regimes?.[c.psc]) err(`${at}: psc regime "${c.psc}" unknown`);
    if (c.register && !registries[c.register] && !/^national:[A-Z]{2}$/.test(c.register)) err(`${at}: register "${c.register}" unknown`);
    if (c.cabotage && c.cabotage.rule !== 'nodata') checkRec(c.cabotage, `${at}.cabotage`);
    if (c.cabotage && !['national', 'bloc', 'licence', 'open', 'nodata'].includes(c.cabotage.rule)) err(`${at}.cabotage: bad rule`);
    if (c.conflict) { checkRec(c.conflict, `${at}.conflict`); for (const id of c.conflict.areaIds || []) if (!areas.some((a) => a.id === id)) err(`${at}.conflict: unknown area ${id}`); }
  }
  // ports
  const hIds = new Set(harbors.map((h) => h.id));
  for (const [id, po] of Object.entries(ports)) {
    if (harbors.length && !hIds.has(id)) err(`ports.${id}: unknown harbour`);
    if (po.status) { checkRec(po.status, `ports.${id}.status`); if (!['open', 'restricted', 'closed'].includes(po.status.value)) err(`ports.${id}.status: bad value`); }
    if (po.entry) { checkRec(po.entry, `ports.${id}.entry`); if (po.entry.corridor && !areas.some((a) => a.id === po.entry.corridor && a.kind === 'corridor')) err(`ports.${id}.entry: unknown corridor`); }
    if (po.psc && !psc.regimes?.[po.psc]) err(`ports.${id}: psc regime "${po.psc}" unknown`);
  }
  // registries
  for (const [id, r] of Object.entries(registries)) {
    checkRec(r, `registries.${id}`);
    if (!['open', 'national', 'international'].includes(r.kind)) err(`registries.${id}: bad kind`);
    if (r.flag && !isCc(r.flag)) err(`registries.${id}: bad flag`);
  }
  // regimes
  const mids = new Set();
  for (const r of regimes) {
    const at = `regimes.${r.id}`;
    checkRec(r, at);
    if (!/^[a-z0-9-]{3,48}$/.test(r.id || '')) err(`${at}: bad id`);
    if (r.target && !isCc(r.target)) err(`${at}: bad target`);
    for (const m of r.measures || []) {
      const mat = `${at}.${m.id}`;
      if (mids.has(m.id)) err(`${mat}: duplicate measure id`); mids.add(m.id);
      if (!MEASURE_KINDS.includes(m.kind)) err(`${mat}: unknown kind ${m.kind}`);
      if (m.enforce && !ENFORCE.includes(m.enforce)) err(`${mat}: bad enforce`);
      checkRec(m, mat, { needSrc: false });
      for (const g of m.goods || []) if (!GOODS_OK.includes(g)) err(`${mat}: unknown good ${g}`);
      for (const c of [...(m.origin || []), ...(m.to || [])]) if (!isCc(c)) err(`${mat}: unknown country ${c}`);
    }
  }
  // areas
  for (const a of areas) {
    const at = `areas.${a.id}`;
    checkRec(a, at);
    if (!AREA_KINDS.includes(a.kind)) err(`${at}: unknown kind`);
    if (a.kind === 'war_risk' && ![1, 2, 3, 4].includes(a.tier)) err(`${at}: tier must be 1–4`);
    if (a.kind === 'corridor' && !(Array.isArray(a.line) && a.line.length >= 2)) err(`${at}: corridor needs a line`);
    if (a.kind !== 'corridor' && !(a.poly || []).length) err(`${at}: polygon required`);
    for (const [i, r] of (a.poly || []).entries()) {
      const rat = `${at}.poly[${i}]`;
      if (r.length > 41) err(`${rat}: more than 40 vertices`);
      if (r.length < 4) { err(`${rat}: fewer than 3 vertices`); continue; }
      const f = r[0], l = r[r.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) err(`${rat}: ring not closed`);
      if (ringArea(r) <= 0) err(`${rat}: outer ring must be counter-clockwise`);
      if (ringSelfIntersects(r)) err(`${rat}: self-intersecting`);
      for (const [lo, la] of r) if (Math.abs(lo * 100 - Math.round(lo * 100)) > 1e-6 || Math.abs(la * 100 - Math.round(la * 100)) > 1e-6) { err(`${rat}: coordinates beyond 0.01°`); break; }
    }
    for (const d of a.discs || []) if (!(d.rKm > 0)) err(`${at}: bad disc`);
  }
  // agreements
  for (const a of agreements) {
    checkRec(a, `agreements.${a.id}`);
    if (!['customs_union', 'fta', 'cooperation'].includes(a.kind)) err(`agreements.${a.id}: bad kind`);
    for (const c of a.members || []) if (!isCc(c)) err(`agreements.${a.id}: unknown member ${c}`);
  }
  // tariffs
  for (const [cc, row] of Object.entries(tariffs)) {
    if (!isCc(cc)) err(`tariffs.${cc}: unknown country`);
    for (const [g, r] of Object.entries(row)) { checkRec(r, `tariffs.${cc}.${g}`); if (r.rate != null && !(r.rate >= 0 && r.rate < 5)) err(`tariffs.${cc}.${g}: bad rate`); }
  }
  // psc
  for (const [id, r] of Object.entries(psc.regimes || {})) {
    checkRec(r, `psc.${id}`);
    for (const c of r.members || []) if (!isCc(c)) err(`psc.${id}: unknown member ${c}`);
    for (const k of ['white', 'grey', 'black']) for (const c of r.lists?.[k] || []) if (!isCc(c)) err(`psc.${id}.lists.${k}: unknown flag ${c}`);
  }
  // trade
  if (trade) {
    for (const [cc, gs] of Object.entries(trade.flows || {})) for (const [g, f] of Object.entries(gs)) {
      const sum = (f.top || []).reduce((s, x) => s + x[1], 0);
      if (sum > 1 + 1e-6) err(`trade.${cc}.${g}: shares sum ${sum.toFixed(3)} > 1`);
      if ((f.top || []).length > 8) err(`trade.${cc}.${g}: more than 8 partners`);
    }
  }
  // banned words
  for (const s of proseStrings(parts)) { const h = bannedHits(s.text); if (h.length) err(`${s.at}: banned word(s) ${h.join(', ')}`); }
  // size budget
  if (sizes) {
    const total = Object.values(sizes).reduce((s, n) => s + n, 0), client = CLIENT_FILES.reduce((s, f) => s + (sizes[f] || 0), 0);
    if (total > BUDGET.totalKB * 1024) err(`size: ${Math.round(total / 1024)} KB > ${BUDGET.totalKB} KB`);
    if (client > BUDGET.clientKB * 1024) err(`size: client subset ${Math.round(client / 1024)} KB > ${BUDGET.clientKB} KB`);
  }
  // loads cleanly
  try { loadDataset({ ...parts, harbors }); } catch (e) { err(`loadDataset: ${e.message}`); }
  return { ok: errors.length === 0, errors, warn };
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const dir = path.resolve(opt('--dir') || DEFAULT_DIR);
  let harbors;
  if (opt('--harbors')) harbors = JSON.parse(fs.readFileSync(opt('--harbors'), 'utf8'));
  else harbors = (await import(pathToFileURL(path.resolve(HERE, '../../server/harbors.js')).href)).HARBORS;
  const { parts, sizes } = readDir(dir);
  const r = validateDataset(parts, { harbors, allowUnverified: args.includes('--allow-unverified'), today: opt('--today') || undefined, sizes });
  const client = CLIENT_FILES.reduce((s, f) => s + (sizes[f] || 0), 0), total = Object.values(sizes).reduce((s, n) => s + n, 0);
  console.log(`[politics] ${dir}: version ${parts.meta?.version}, ${Object.keys(parts.countries || {}).length} countries, ${(parts.regimes || []).length} regimes, ${(parts.areas || []).length} areas, ${Math.round(client / 1024)} KB client / ${Math.round(total / 1024)} KB total`);
  for (const e of r.errors) console.log('  ERROR ' + e);
  console.log(r.ok ? '[politics] OK' : `[politics] ${r.errors.length} error(s)`);
  process.exit(r.ok ? 0 : 1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
