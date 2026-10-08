#!/usr/bin/env node
// Operator command (docs/WORLD-DETAIL-STREAMING.md §5.4, Q2): show or move the pinned OpenFreeMap planet version in
// data/world/pin.json. Cached tiles stay valid (each is stamped with its own source version) and are rebuilt lazily
// against the new pin. The running server reads pin.json at start: restart it after a re-pin (it also re-pins by itself
// when the pinned version disappears upstream).
//
//   node scripts/wt-repin.mjs            show the pinned and the newest version
//   node scripts/wt-repin.mjs --apply    pin the newest version
import { createSources } from '../server/wtsource.js';
import { DATA_DIR } from '../server/paths.js';

const apply = process.argv.includes('--apply');
const src = createSources({ offline: false, dataDir: DATA_DIR, log: (...a) => console.log(...a) });
const pinned = src.pin;
const latest = await src.latestVersion();
console.log('data dir      ', DATA_DIR);
console.log('pinned        ', pinned || '(none yet)');
console.log('newest upstream', latest || '(TileJSON unreachable)');
if (!latest) process.exitCode = 1;
else if (pinned === latest) console.log('nothing to do');
else if (!apply) console.log('run with --apply to pin', latest);
else console.log('pinned', await src.repin('operator'));
