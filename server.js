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
import { SIM } from './shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const world = new World().load(carvingsForWorld(), log);
const game = new Game(world, log);

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Cache-Control', req.path.startsWith('/api/tile') || req.path.startsWith('/api/chart') ? 'public, max-age=3600' : 'no-cache'); next(); });
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
app.use('/shared', express.static(path.join(__dirname, 'shared'), { extensions: ['js'] }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));

app.get('/api/health', (req, res) => res.json({ ok: true, players: [...game.byId.values()].filter((p) => p.online).length, simTime: Math.round(game.simTime), uptime: process.uptime() }));
app.get('/api/world', (req, res) => res.json(game.worldInfo()));
app.get('/api/tile/:level/:tx/:ty', (req, res) => {
  const t = world.tile(+req.params.level, +req.params.tx, +req.params.ty);
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
  try { game.tick(dt); } catch (e) { log('[game] tick error', e.stack || e); }
}, 1000 / SIM.SERVER_TICK_HZ);
setInterval(() => { try { game.broadcastSnapshot(); } catch (e) { log('[game] snapshot error', e.stack || e); } }, 1000 / SIM.SNAPSHOT_HZ);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down, saving state'); game.saveState(); process.exit(0); });
process.on('uncaughtException', (e) => { log('[fatal] uncaught', e.stack || e); game.saveState(); });
process.on('unhandledRejection', (e) => log('[warn] unhandled rejection', e));

server.listen(PORT, () => log(`Saltline shard listening on :${PORT} — ${HARBORS.length} harbours, sim time ${Math.round(game.simTime)} s`));
