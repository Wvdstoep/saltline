// Worker thread of server/worldtiles.js (docs/WORLD-DETAIL-STREAMING.md §3.3): decodeMVT → convertTile → encodeTile →
// gzip, one tile per message, so the 10 Hz game tick never waits for a conversion.
// Messages: main → { id, z, x, y, mvt (Uint8Array, raw or gzip'd MVT), overlay, bathy ({ x9, y9, dm }), hints };
// worker → { ready: true } once, then { id, ok: true, raw, gz, ms, flags, rev } (raw / gz transferred) | { id, ok: false,
// error }. The same pipeline is exported as convertJob() for the inline mode (tests, worker unavailable).
import { parentPort } from 'node:worker_threads';
import zlib from 'node:zlib';
import { decodeMVT } from './mvt.js';
import { convertTile } from './wtconvert.js';
import { encodeTile } from '../shared/wtformat.js';

/** One job → { raw: Uint8Array (SLWT), gz: Uint8Array, ms, flags, rev }. Throws on a broken job (caller catches). */
export function convertJob(m) {
  const t0 = Date.now();
  const mvt = m.mvt && m.mvt.length ? decodeMVT(m.mvt) : { layers: {} };
  if (mvt.error) throw new Error('bad MVT: ' + mvt.error);
  const bathy = m.bathy && m.bathy.dm ? { x9: m.bathy.x9, y9: m.bathy.y9, dm: m.bathy.dm instanceof Int16Array ? m.bathy.dm : new Int16Array(m.bathy.dm.buffer || m.bathy.dm) } : null;
  const t = convertTile({ z: m.z, x: m.x, y: m.y, mvt, overlay: m.overlay || null, bathy, hints: m.hints || {} });
  const raw = encodeTile(t);
  const gz = new Uint8Array(zlib.gzipSync(raw, { level: 6 }));
  return { raw, gz, ms: Date.now() - t0, flags: t.flags, rev: t.rev };
}

if (parentPort) {
  parentPort.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    try {
      const r = convertJob(m);
      parentPort.postMessage({ id: m.id, ok: true, ...r }, [r.raw.buffer, r.gz.buffer]);
    } catch (e) {
      parentPort.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
    }
  });
  parentPort.postMessage({ ready: true });
}
