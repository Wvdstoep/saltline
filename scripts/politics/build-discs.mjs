#!/usr/bin/env node
// Write bbox and covering discs (for the route planner's avoid list) into shared/politics/areas.json.
// Discs: minimum enclosing circle of each ring; above 600 km split along the longer bbox axis, depth ≤ 2 (≤ 4 discs
// per ring). loadDataset() computes the same values when a row has none, so this only keeps the file self-describing.
//   node scripts/politics/build-discs.mjs [--dir shared/politics]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaDiscs } from '../../shared/politics.js';
import { DEFAULT_DIR } from './validate.mjs';

export function withDiscs(area) {
  const pts = [...(area.poly || []).flat(), ...(area.line || [])];
  let w = 180, s = 90, e = -180, n = -90;
  for (const [lo, la] of pts) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { ...area, bbox: pts.length ? [r2(w), r2(s), r2(e), r2(n)] : null, discs: areaDiscs(area) };
}
export function dumpArray(list) { return '[\n' + list.map((x) => JSON.stringify(x)).join(',\n') + '\n]\n'; }

function main() {
  const args = process.argv.slice(2), i = args.indexOf('--dir');
  const file = path.join(path.resolve(i >= 0 ? args[i + 1] : DEFAULT_DIR), 'areas.json');
  const areas = JSON.parse(fs.readFileSync(file, 'utf8')).map(withDiscs);
  fs.writeFileSync(file, dumpArray(areas));
  for (const a of areas) console.log(`  ${a.id}: ${a.discs.length} disc(s), max ${Math.max(0, ...a.discs.map((d) => d.rKm))} km`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
