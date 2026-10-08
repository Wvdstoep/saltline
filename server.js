// Saltline server: static client + world tile/chart API + WebSocket multiplayer shard.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { World, DATA_DIR } from './server/world.js';
import { carvingsForWorld, HARBORS } from './server/harbors.js';
import { Game } from './server/game.js';
import { SIM, PATCH, SHIP_CLASSES } from './shared/constants.js';
import * as harborgeom from './server/harborgeom.js';
import { WeatherService } from './server/weather.js';
import { Traffic } from './server/traffic.js';
import { LANE_NODES } from './server/lanes.js';
import { planRoute, parseRouteQuery } from './server/searoute.js';                 // AUTOPILOT (planRoute stays for the fallback)
import { RoutePlanner } from './server/routeworker.js';                           // AUTOPILOT
import { RouteTable } from './server/routetable.js';                              // MARKET
import { PriceHistory, cachedSnapshot, routesHandler, historyAnswer } from './server/market.js'; // MARKET
import { tideAt } from './shared/tide.js';
import zlib from 'node:zlib';
import { getTile } from './server/maptiles.js';
import { LiveAis } from './server/ais/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const world = new World().load(carvingsForWorld(), log);
harborgeom.init(world);
const weather = new WeatherService({ log });
let game = null;
const traffic = new Traffic(world, HARBORS, { log, weatherAt: (lat, lon) => (game ? game.weatherAt(lat, lon) : null) });
const routePlanner = new RoutePlanner({ world, graph: traffic.graph, geom: harborgeom, log });            // AUTOPILOT (route planner v2 off the main thread)
const routeTable = new RouteTable({ plan: (a, b, o) => routePlanner.plan(a, b, o, { priority: 'low' }), log }); // MARKET (harbour-to-harbour sea km)
game = new Game(world, log, { weather, traffic, harborgeom, routeTable });     // MARKET adds routeTable; TIME reads it
const priceHistory = new PriceHistory({ file: path.join(DATA_DIR, 'market-history.json'), log });           // MARKET
priceHistory.load(); priceHistory.maybeSample(game); routeTable.start();                                     // MARKET
setInterval(() => { try { priceHistory.maybeSample(game); } catch (e) { log('[market] sample failed', e.message); } }, 60000);
// Live AIS (AISStream worldwide with the key in data/secrets/aisstream.key or AISSTREAM_API_KEY; Digitraffic Baltic):
// where real ships are reported, the invented AI traffic steps aside so the two never overlap.
const liveAis = new LiveAis({ log, harbors: HARBORS });
liveAis.start();
game.aiFilter = (a) => !liveAis.covers(a.lat, a.lon);
game.liveAis = liveAis;                     // V7 step 0: the express passage keeps clear of live AIS vessels
const AIS_NEAR_M = 40000, AIS_NEAR_LIMIT = 200, AIS_PUSH_MS = 2000;
if (process.env.SALTLINE_PREFETCH === '1') harborgeom.prefetchAll({ delayMs: 1500 }).catch((e) => log('[geom] prefetch failed', e.message));

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Cache-Control', req.path.startsWith('/api/tile') || req.path.startsWith('/api/chart') ? 'public, max-age=3600' : 'no-cache'); next(); });
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
app.use('/shared', express.static(path.join(__dirname, 'shared'), { extensions: ['js'] }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));

app.get('/api/health', (req, res) => { const a = liveAis.stats(); res.json({ ok: true, players: [...game.byId.values()].filter((p) => p.online).length, simTime: Math.round(game.simTime), uptime: process.uptime(), ais: { vessels: a.vessels, offline: a.offline, sources: Object.fromEntries(Object.entries(a.sources).map(([k, v]) => [k, { enabled: !!v.enabled, connected: !!v.connected, msgs: v.msgs ?? 0 }])) }, route: routePlanner.stats(), market: { samples: priceHistory.samples, routes: routeTable.stats() }, rssMB: Math.round(process.memoryUsage().rss / 1048576) }); });
app.get('/api/world', (req, res) => res.json({ ...game.worldInfo(), lanes: LANE_NODES, patch: PATCH }));
// v0.3: high-resolution harbour geometry (docs/V3-CONTRACTS.md §1). First build of a harbour may take a few seconds.
const validId = (id) => /^[a-z0-9_]{1,40}$/.test(id);
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
app.get('/api/harbor/:id/geom', async (req, res) => {
  const id = req.params.id; if (!validId(id)) return res.status(400).end();
  try {
    const g = harborgeom.getHarborGeom(id) || (await withTimeout(harborgeom.ensureHarbor(id), 20000));
    if (!g) return res.status(404).json({ error: 'not available' });
    res.setHeader('Cache-Control', 'public, max-age=600'); res.json(g);
  } catch (e) { log('[geom] route error', e.message); res.status(500).end(); }
});
app.get('/api/harbor/:id/patch', async (req, res) => {
  const id = req.params.id; if (!validId(id)) return res.status(400).end();
  try {
    if (!harborgeom.getHarborPatch(id)) await withTimeout(harborgeom.ensureHarbor(id), 20000);
    const buf = harborgeom.getHarborPatch(id);
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Cache-Control', 'public, max-age=600');
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.setHeader('Content-Encoding', 'gzip'); res.end(zlib.gzipSync(buf)); } else res.end(buf);
  } catch (e) { log('[geom] route error', e.message); res.status(500).end(); }
});
app.get('/api/weather', (req, res) => { const lat = +req.query.lat, lon = +req.query.lon; if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).end(); res.json(game.weatherAt(lat, lon)); });
app.get('/api/tide', (req, res) => { const lat = +req.query.lat, lon = +req.query.lon; if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).end(); res.json(tideAt(lat, lon, Date.now() / 1000)); });
app.get('/api/ai', (req, res) => res.json(traffic.all().filter((a) => !liveAis.covers(a.lat, a.lon))));
// Live AIS for the chart: every vessel in a box (decimated over the limit), and one vessel with its track.
app.get('/api/ais', (req, res) => {
  const b = String(req.query.bbox || '').split(',').map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite) || b[0] >= b[2] || Math.abs(b[0]) > 90 || Math.abs(b[2]) > 90) return res.status(400).json({ error: 'bbox=latMin,lonMin,latMax,lonMax' });
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 2000));
  try { res.json({ time: Date.now(), ships: liveAis.bbox(b[0], b[1], b[2], b[3], { limit }) }); } catch (e) { log('[ais] bbox failed', e.message); res.status(500).end(); }
});
app.get('/api/ais/:mmsi', (req, res) => {
  const m = Number(String(req.params.mmsi).replace(/^ais/, ''));
  if (!Number.isInteger(m) || m <= 0) return res.status(400).end();
  const v = liveAis.get(m); if (!v) return res.status(404).end();
  res.json(v);
});
// v0.4: cached map tile proxy (OSM raster + OpenSeaMap seamarks) for the chart and the street-level terrain drape
app.get('/api/maptile/:layer/:z/:x/:y.png', async (req, res) => {
  const { layer } = req.params; const [z, x, y] = [req.params.z, req.params.x, req.params.y].map((v) => (/^\d{1,7}$/.test(v) ? +v : NaN));
  if (!['osm', 'seamark'].includes(layer) || ![z, x, y].every(Number.isInteger) || z < 2 || z > 18 || x >= 2 ** z || y >= 2 ** z) return res.status(400).end();
  try {
    const t = await getTile(layer, z, x, y);
    // Not available right now (upstream unreachable / backing off, or no such tile): 204 + no-store, so the browser
    // asks again later and does not log a console error per tile; the chart and the drape treat it as a miss.
    if (!t) { res.setHeader('Cache-Control', 'no-store'); return res.status(204).end(); }
    res.setHeader('Content-Type', t.type || 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.end(t.buf);
  } catch (e) { res.status(502).end(); }
});
app.get('/api/tile/:level/:tx/:ty', (req, res) => {
  const [level, tx, ty] = [req.params.level, req.params.tx, req.params.ty].map((v) => (/^\d{1,5}$/.test(v) ? +v : NaN));
  if (![level, tx, ty].every(Number.isInteger)) return res.status(400).end();
  const t = world.tile(level, tx, ty);
  if (!t) return res.status(404).end();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.end(Buffer.from(t.buffer, t.byteOffset, t.byteLength));
});
app.get('/api/chart/world.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(world.chartPNG(0, 4)); });
app.get('/api/chart/region.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(world.chartPNG(1, 4)); });
app.get('/api/height', (req, res) => res.json({ h: world.heightAt(+req.query.lat, +req.query.lon) }));
app.get('/api/osm', (req, res) => {
  const f = path.join(DATA_DIR, 'osm-harbors.json');
  if (!fs.existsSync(f)) return res.json({ harbors: {} });
  res.setHeader('Content-Type', 'application/json'); fs.createReadStream(f).pipe(res);
});
app.get('/api/jobs', (req, res) => res.json(game.publicJobs()));
// Sea route planner v2 (docs/V6-QUICK-CONTRACTS.md §4.5): over water deep enough for the class's draught at low water,
// out of / into built harbour patches along the fairway, the Dover TSS lanes the right way, round the given storm discs.
// /api/route?from=lat,lon&to=lat,lon[&harbor=id][&cls=class][&wp=lat,lon;…][&avoid=lat,lon,radiusKm[,name];…]
const routeHits = new Map();
setInterval(() => routeHits.clear(), 60000).unref?.();
app.get('/api/route', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
  const hits = (routeHits.get(ip) || 0) + 1; routeHits.set(ip, hits);
  if (hits > 30) return res.status(429).json({ error: 'too many route requests — try again in a minute' });
  const q = parseRouteQuery(req.query);
  if (!q.ok) return res.status(400).json({ error: q.error });
  if (routePlanner.full()) return res.status(503).json({ error: 'route planner busy' });
  const C = q.cls ? SHIP_CLASSES[q.cls] : null;
  try { if (q.toHarbor && !harborgeom.getHarborPatch(q.toHarbor)) await withTimeout(harborgeom.ensureHarbor(q.toHarbor), 3000); } catch { /* plan without the patch */ }
  let r = null;
  try {
    r = await routePlanner.plan(q.from, q.to, { toHarbor: q.toHarbor, draft: C ? C.draft : 0, beam: C ? C.beam : 0, length: C ? C.length : 0, wp: q.wp, avoid: q.avoid, simTime: Date.now() / 1000 }, { priority: 'high' });
  } catch (e) { log('[route] failed', e.message); }
  if (!r) return res.status(routePlanner.full() ? 503 : 404).json({ error: routePlanner.full() ? 'route planner busy' : 'no sea route found' });
  res.json(r);
});
// World market (docs/V6-QUICK-CONTRACTS.md §3.4): every harbour's prices, the hourly price history, the trade finder.
app.get('/api/market', (req, res) => res.json(cachedSnapshot(game)));
app.get('/api/market/history', (req, res) => { const a = historyAnswer(priceHistory, req.query); res.status(a.status).json(a.body); });
app.get('/api/market/routes', routesHandler({ game, routeTable }));
app.get('/api/players', (req, res) => res.json([...game.byId.values()].filter((p) => p.online).map((p) => game.publicState(p))));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws, req) => {
  let player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!player) {
      if (m.t !== 'hello') return;
      player = game.connect(ws, m.token, m.name);
      return;
    }
    switch (m.t) {
      case 'state': game.onState(player, m); break;
      case 'action': game.onAction(player, m); break;
      case 'chat': game.onChat(player, m.text); break;
      case 'ping': ws.send(JSON.stringify({ t: 'pong', c: m.c, time: Date.now() })); break;
    }
  });
  ws.on('close', () => { if (player && game.sockets.get(player.id) === ws) game.disconnect(player); });
  ws.on('error', (e) => log('[ws] error', e.message));
});

setInterval(() => {
  for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 30000);

// Live AIS push: AISStream follows the online skippers; each one gets the real ships within 40 km every 2 s.
setInterval(() => {
  try {
    const online = [...game.byId.values()].filter((p) => p.online);
    liveAis.setInterest(online.map((p) => ({ lat: p.ship.lat, lon: p.ship.lon })));
    const time = Date.now();
    for (const [id, ws] of game.sockets) {
      if (ws.readyState !== 1) continue;
      const p = game.byId.get(id); if (!p) continue;
      ws.send(JSON.stringify({ t: 'ais', time, ships: liveAis.near(p.ship.lat, p.ship.lon, AIS_NEAR_M, { limit: AIS_NEAR_LIMIT }) }));
    }
  } catch (e) { log('[ais] push failed', e.message); }
}, AIS_PUSH_MS);

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(1, (now - last) / 1000); last = now;
  try { weather.tick(); } catch (e) { log('[weather] tick error', e.message); }
  try { traffic.tick(dt); } catch (e) { log('[traffic] tick error', e.stack || e); }
  try { game.tick(dt); } catch (e) { log('[game] tick error', e.stack || e); }
}, 1000 / SIM.SERVER_TICK_HZ);
setInterval(() => { try { game.broadcastSnapshot(); } catch (e) { log('[game] snapshot error', e.stack || e); } }, 1000 / SIM.SNAPSHOT_HZ);

// Shutdown: ONE handler pair (docs/V6-QUICK-CONTRACTS.md §6.2). `{ sync: true }` is wave 2's synchronous save; before
// wave 2, saveState ignores the argument.
function saveAll(why) {
  log(why);
  try { game.saveState({ sync: true }); } catch (e) { log('[save] state failed', e.message); }
  try { priceHistory?.save(); } catch (e) { log('[save] market history failed', e.message); }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveAll('shutting down, saving state'); try { routePlanner?.close(); } catch {} process.exit(0); });
process.on('uncaughtException', (e) => { log('[fatal] uncaught', e.stack || e); saveAll('saving after an uncaught exception'); });
process.on('unhandledRejection', (e) => log('[warn] unhandled rejection', e));

server.listen(PORT, () => log(`Saltline shard listening on :${PORT} — ${HARBORS.length} harbours, sim time ${Math.round(game.simTime)} s`));
