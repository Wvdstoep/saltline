#!/usr/bin/env node
// Maintainer helper for the world-politics dataset (docs/WORLD-POLITICS-CONTRACT.md §3.14).
//   node scripts/politics/refresh.mjs --stale [--today YYYY-MM-DD]   records past reviewBy, conflict/status first
//   node scripts/politics/refresh.mjs --links                         HEAD/GET every source URL (10 s timeout)
//   node scripts/politics/refresh.mjs --bump                          meta.version → next YYYY.MM.n, validAsOf → today
// It never edits rules: legal texts, JWC circulars and insurer rates need a person to read them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDir, DEFAULT_DIR } from './validate.mjs';

export const CHECKLIST = [
  'The Joint War Committee circular in force (LMA / IUA listed areas)',
  'The IBF / JNG warlike operations area list',
  'UKMTO / JMIC / MSCHOA advisories for port status and corridors',
  'EU Sanctions Map, UK sanctions guidance (OFSI/OTSI), OFAC programme pages, UN Security Council sanctions committees',
  'Paris and Tokyo MoU annual flag lists (published in summer)',
  'WTO World Tariff Profiles (yearly)',
  'CEPII BACI release (yearly) → scripts/politics/build-trade.mjs',
  'IMO MEPC outcomes for ECAs',
  'Then: node scripts/politics/validate.mjs && node scripts/politics/refresh.mjs --bump',
];

/** Every record with a reviewBy before `today`, conflict/status records (30-day review) first. */
export function staleRecords(parts, today) {
  const out = [];
  const visit = (o, at) => {
    if (Array.isArray(o)) return o.forEach((v, i) => visit(v, `${at}[${v && v.id ? v.id : i}]`));
    if (!o || typeof o !== 'object') return;
    if (o.reviewBy && o.reviewBy < today) {
      const short = o.asOf && o.reviewBy && (Date.parse(o.reviewBy) - Date.parse(o.asOf)) <= 45 * 86400e3;
      out.push({ at, reviewBy: o.reviewBy, asOf: o.asOf || null, src: o.src || [], conflict: !!short });
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') visit(v, at ? `${at}.${k}` : k);
  };
  for (const [f, v] of Object.entries(parts)) visit(v, f);
  return out.sort((a, b) => (b.conflict - a.conflict) || a.reviewBy.localeCompare(b.reviewBy));
}
export function nextVersion(cur, today) {
  const ym = today.slice(0, 7).replace('-', '.');
  const m = /^(\d{4}\.\d{2})\.(\d+)$/.exec(cur || '');
  return m && m[1] === ym ? `${ym}.${+m[2] + 1}` : `${ym}.1`;
}
async function checkLink(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
    if (r.status === 405 || r.status === 403) r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal });
    return r.ok ? null : `HTTP ${r.status}`;
  } catch (e) { return e.name === 'AbortError' ? 'timeout' : e.message; } finally { clearTimeout(t); }
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const dir = path.resolve(opt('--dir') || DEFAULT_DIR), today = opt('--today') || new Date().toISOString().slice(0, 10);
  const { parts } = readDir(dir);
  if (args.includes('--stale') || !args.length) {
    const st = staleRecords(parts, today);
    console.log(`[politics] ${st.length} record(s) past reviewBy on ${today}:`);
    for (const r of st) console.log(`  ${r.conflict ? 'CONFLICT ' : ''}${r.at} — review by ${r.reviewBy} (as of ${r.asOf}; ${r.src.join(', ')})`);
    console.log('\nChecklist:'); CHECKLIST.forEach((c, i) => console.log(`  (${i + 1}) ${c}`));
  }
  if (args.includes('--links')) {
    const dead = [];
    for (const [id, s] of Object.entries(parts.sources || {})) { if (!s.url) continue; const e = await checkLink(s.url); if (e) dead.push(`${id}: ${e} — ${s.url}`); }
    console.log(dead.length ? `[politics] ${dead.length} dead link(s):\n  ${dead.join('\n  ')}` : '[politics] all source links answer');
  }
  if (args.includes('--bump')) {
    const p = path.join(dir, 'meta.json'), meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    meta.version = nextVersion(meta.version, today); meta.validAsOf = today;
    fs.writeFileSync(p, JSON.stringify(meta, null, 1) + '\n');
    console.log(`[politics] meta.version → ${meta.version}, validAsOf → ${today}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
