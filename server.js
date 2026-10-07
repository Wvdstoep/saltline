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
import { SIM, PATCH } from './shared/constants.js';
import * as harborgeom from './server/harborgeom.js';
import { WeatherService } from './server/weather.js';
import { Traffic } from './server/traffic.js';
import { LANE_NODES } from './server/lanes.js';
import { tideAt } from './shared/tide.js';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const world = new World().load(carvingsForWorld(), log);
harborgeom.init(world);
const weather = new WeatherService({ log });
let game = null;
const traffic = new Traffic(world, HARBORS, { log, weatherAt: (lat, lon) => (game ? game.weatherAt(lat, lon) : null) });
game = new Game(world, log, { weather, traffic, harborgeom });
if (process.env.SALTLINE_PREFETCH === '1') harborgeom.prefetchAll({ delayMs: 1500 }).catch((e) => log('[geom] prefetch failed', e.message));

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Cache-Control', req.path.startsWith('/api/tile') || req.path.startsWith('/api/chart') ? 'public, max-age=3600' : 'no-cache'); next(); });
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
app.use('/shared', express.static(path.join(__dirname, 'shared'), { extensions: ['js'] }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));

app.get('/api/health', (req, res) => res.json({ ok: true, players: [...game.byId.values()].filter((p) => p.online).length, simTime: Math.round(game.simTime), uptime: process.uptime() }));
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
app.get('/api/ai', (req, res) => res.json(traffic.all()));
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

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(1, (now - last) / 1000); last = now;
  try { weather.tick(); } catch (e) { log('[weather] tick error', e.message); }
  try { traffic.tick(dt); } catch (e) { log('[traffic] tick error', e.stack || e); }
  try { game.tick(dt); } catch (e) { log('[game] tick error', e.stack || e); }
}, 1000 / SIM.SERVER_TICK_HZ);
setInterval(() => { try { game.broadcastSnapshot(); } catch (e) { log('[game] snapshot error', e.stack || e); } }, 1000 / SIM.SNAPSHOT_HZ);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down, saving state'); game.saveState(); process.exit(0); });
process.on('uncaughtException', (e) => { log('[fatal] uncaught', e.stack || e); game.saveState(); });
process.on('unhandledRejection', (e) => log('[warn] unhandled rejection', e));

server.listen(PORT, () => log(`Saltline shard listening on :${PORT} — ${HARBORS.length} harbours, sim time ${Math.round(game.simTime)} s`));
