// Static server for the offline interiors viewer (public/iv2view.html): the same routes as server.js (/vendor three.js,
// /shared, public) without the game. node scripts/interiors/viewserve.mjs [port]  →  http://localhost:<port>/iv2view.html?model=ultramax64&shot=bridge
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.argv[2] || process.env.PORT || 3421);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function resolve(url) {
  const p = decodeURIComponent(url.split('?')[0]);
  if (p.startsWith('/vendor/')) return path.join(ROOT, 'node_modules/three/build', p.slice(8));
  if (p.startsWith('/shared/')) { const f = path.join(ROOT, 'shared', p.slice(8)); return fs.existsSync(f) ? f : f + '.js'; }
  if (p.startsWith('/docs/')) return path.join(ROOT, p.slice(1));
  return path.join(ROOT, 'public', p === '/' ? 'iv2view.html' : p);
}
http.createServer((req, res) => {
  const f = resolve(req.url);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log(`iv2 viewer: http://localhost:${port}/iv2view.html`));
