// Worker thread of server/routeworker.js: its own world raster (the cached .bin files) and lane graph, then one
// planRoute per message. Messages: main → { id, from, to, opts, ends: [{ id, patch, fairway, anchor }] };
// worker → { ready, ms } once, then { id, ok: true, result } | { id, ok: false, error }.
import { parentPort, workerData } from 'node:worker_threads';

if (workerData?.dataDir) process.env.SALTLINE_DATA = workerData.dataDir;
const t0 = Date.now();
const { World } = await import('./world.js');
const { carvingsForWorld } = await import('./harbors.js');
const { buildGraph } = await import('./lanes.js');
const { planRoute } = await import('./searoute.js');

const world = new World().load(carvingsForWorld(), () => {});
const graph = buildGraph(world);
// BRIDGES & LOCKS (docs/WATERWAYS-LANE1-PHASE2.md §5): the inland graph (FIS fairways, bridges, locks) joined to the sea at the gates
let inl = null, inland = null;
if (process.env.SALTLINE_WW_OFF !== '1') {
  try {
    const { loadFis } = await import('./fis.js');
    inl = await import('./inland.js');
    const fs = await import('node:fs');
    const levels = JSON.parse(fs.readFileSync(new URL('./waterworks/levels-nl.json', import.meta.url), 'utf8'));
    const gates = JSON.parse(fs.readFileSync(new URL('./waterworks/seagates-nl.json', import.meta.url), 'utf8')).gates;
    inland = inl.joinSeaGates(inl.buildGraph(loadFis(), { levels }), gates);
  } catch { inland = null; }
}
const llPts = (r) => (r && Array.isArray(r.points) ? { ...r, points: r.points.map((p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : p)) } : r);   // inland legs give [lat, lon]
// warm the per-edge depth cache (the first deep-draught plan would otherwise pay for it)
try { planRoute(world, graph, { lat: 51.95, lon: 4.05 }, { lat: 57.7, lon: 11.9 }, { draft: 5.5, beam: 14 }); } catch { /* warm-up only */ }

// harbour patches by id + length (the clearance transform of a patch costs ~30 ms; harbours rebuild rarely)
const patches = new Map();
function geomFrom(ends) {
  const byId = new Map();
  for (const e of ends || []) {
    if (!e || typeof e.id !== 'string' || !e.patch) continue;
    const key = `${e.id}:${e.patch.length}`;
    let buf = patches.get(key);
    if (!buf) { buf = e.patch instanceof Uint8Array ? e.patch : new Uint8Array(e.patch); patches.set(key, buf); if (patches.size > 40) patches.delete(patches.keys().next().value); }
    byId.set(e.id, { buf, geom: { fairway: e.fairway || null, anchor: e.anchor || null }, anchor: e.anchor || null });
  }
  if (!byId.size) return null;
  return {
    getHarborPatch: (id) => byId.get(id)?.buf || null,
    getHarborGeom: (id) => byId.get(id)?.geom || null,
    harborAnchor: (id) => byId.get(id)?.anchor || null,
    landPenetration: () => null,
  };
}

parentPort.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  try {
    const sea = (a, b) => planRoute(world, graph, a, b, { ...(m.opts || {}), geom: geomFrom(m.ends) });
    const o = m.opts || {};
    const result = inland && o.inland && (o.inland.from || o.inland.to)
      ? llPts(inl.planWithSea(sea, inland, m.from, m.to, o.inland.ship, o.simTime, { fromInland: !!o.inland.from, toInland: !!o.inland.to })) || sea(m.from, m.to)
      : sea(m.from, m.to);
    parentPort.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
});
parentPort.postMessage({ ready: true, ms: Date.now() - t0 });
