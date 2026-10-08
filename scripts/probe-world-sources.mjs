#!/usr/bin/env node
// Phase-0 source probe (docs/WORLD-DETAIL-STREAMING.md §7 phase 0): one polite request per check, ≤ 15 s each.
//   node scripts/probe-world-sources.mjs [--overpass] [--emodnet]
// Prints status, bytes, ms, the MVT layers and the class values seen (water / transportation / landuse / landcover)
// so the converter's class mapping can be checked against the OpenMapTiles schema version actually served.
import { decodeMVT, summarizeMVT } from '../server/mvt.js';
import { tileF } from '../shared/wtformat.js';
import { UA, OFM_TILEJSON, terrariumUrl, OVERPASS_URLS, overlayQuery } from '../server/wtsource.js';

const args = new Set(process.argv.slice(2));
const T = 15000;
async function get(url, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(T) });
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, bytes: buf.length, ms: Date.now() - t0, buf, type: res.headers.get('content-type') };
  } catch (e) { return { status: 0, bytes: 0, ms: Date.now() - t0, error: e.message }; }
}
const line = (name, r) => console.log(`${name.padEnd(28)} ${String(r.status).padEnd(4)} ${String(r.bytes).padStart(8)} B ${String(r.ms).padStart(6)} ms${r.error ? ' ' + r.error : ''}`);

const tj = await get(OFM_TILEJSON);
line('OpenFreeMap TileJSON', tj);
let template = null;
if (tj.status === 200) {
  try { const j = JSON.parse(new TextDecoder().decode(tj.buf)); template = j.tiles?.[0] || null; console.log('  tiles:', template, 'maxzoom', j.maxzoom); } catch (e) { console.log('  bad JSON', e.message); }
}
const POINTS = [['Rotterdam Amazonehaven', 51.968, 4.035], ['Singapore Strait', 1.2, 103.85], ['Santos channel', -23.98, -46.30], ['North Sea open', 54.5, 3.0]];
if (template) {
  for (const [name, lat, lon] of POINTS) {
    const { fx, fy } = tileF(14, lat, lon), x = Math.floor(fx), y = Math.floor(fy);
    const r = await get(template.replace('{z}', 14).replace('{x}', x).replace('{y}', y));
    line(`${name} 14/${x}/${y}`, r);
    if (r.status === 200) {
      const m = decodeMVT(r.buf);
      if (m.error) console.log('  decode error', m.error);
      for (const [l, s] of Object.entries(summarizeMVT(m))) {
        const keys = new Set(); for (const f of m.layers[l].features) for (const k of Object.keys(f.tags)) keys.add(k);
        console.log(`  ${l.padEnd(16)} n=${String(s.n).padStart(5)} extent=${s.extent} classes=${JSON.stringify(s.classes)} keys=${[...keys].join(',')}`);
      }
    }
  }
}
{
  const { fx, fy } = tileF(9, 51.968, 4.035);
  line('Terrarium z9 Rotterdam', await get(terrariumUrl(9, Math.floor(fx), Math.floor(fy))));
}
if (args.has('--overpass')) {
  const { fx, fy } = tileF(12, 51.968, 4.035);
  const r = await get(OVERPASS_URLS[0], { method: 'POST', body: 'data=' + encodeURIComponent(overlayQuery(Math.floor(fx), Math.floor(fy))), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  line('Overpass overlay z12', r);
  if (r.status === 200) { try { const j = JSON.parse(new TextDecoder().decode(r.buf)); console.log('  elements', j.elements?.length); } catch { /* not JSON */ } }
}
if (args.has('--emodnet')) line('EMODnet depth sample', await get('https://rest.emodnet-bathymetry.eu/depth_sample?geom=POINT(3.70%2052.05)'));
