// Loads the world-economy dataset (shared/econ/*) for the server and the /api/econ/data payload
// (docs/WORLD-ECONOMY-CONTRACT.md §5, §15). The dataset is immutable per econVersion; one instance per process.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { CATALOGUE, CATS } from '../shared/econ/catalogue.js';
import { SEASONS } from '../shared/econ/seasons.js';
import { CHAINS } from '../shared/econ/chains.js';
import { loadEcon } from '../shared/econ/model.js';
import { TAG_SEEDS } from '../shared/jobs/ports.js';
import { PLATFORMS } from './harbors.js';

const DIR = fileURLToPath(new URL('../shared/econ/', import.meta.url));
export function readJson(name) { return JSON.parse(fs.readFileSync(DIR + name, 'utf8')); }

let cached = null;
/** The parts loadEcon takes (plain data); `over` replaces parts (tests, fixtures). */
export function econParts(over = {}) {
  return {
    catalogue: CATALOGUE, countries: readJson('countries.json'), seasons: SEASONS, chains: CHAINS, sites: readJson('sites.json'),
    meta: readJson('meta.json'), platforms: PLATFORMS.map((p) => ({ lat: p.lat, lon: p.lon })), tags: { ice: TAG_SEEDS.ice || [] },
    ...over,
  };
}
/** The process-wide dataset (built once). */
export function econDataset() { return cached || (cached = loadEcon(econParts())); }

let payload = null;
/** GET /api/econ/data body and its ETag (immutable per econVersion). */
export function econPayload() {
  if (payload) return payload;
  const body = {
    v: readJson('meta.json').econVersion, catalogue: CATALOGUE, cats: CATS, countries: readJson('countries.json'), seasons: SEASONS,
    chains: CHAINS, sites: readJson('sites.json'), sources: readJson('sources.json'),
  };
  const text = JSON.stringify(body);
  payload = { body, text, etag: `"econ-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}"` };
  return payload;
}
