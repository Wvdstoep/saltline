// World detail tiles — module worker (docs/WORLD-DETAIL-STREAMING.md §3.7). Decodes an SLWT tile (already un-gzipped
// by the browser: the server sends Content-Encoding: gzip) and builds its meshes with wtmesh.js, answering with raw
// typed arrays (transferred, zero-copy). Import maps do not apply inside workers, so nothing here imports 'three'; the
// relative imports resolve to /js/wtmesh.js and /shared/wtformat.js.
//
// in : { id, buf: ArrayBuffer (SLWT bytes, copied), opts: { lod, coarse: {n, h}, structures, maxBuildings, minBuildingH,
//        maxVerts, meshes } }
// out: { id, ok: true, tile: { z, x, y, flags, n, rev, uniformH, srcHash, contentHash, mask, height, src, ov },
//        terrain, structures, city, ms, bytes }  |  { id, ok: false, error }
// opts.city ({ want, mobile, exclude }) adds the city layer (citymesh.js: buildings with facades, trees, containers);
// the tile's own flat building boxes are then left out of `structures`.
import { decodeTile } from '../../shared/wtformat.js';
import { buildTile } from './wtmesh.js';
import { buildCity } from './citymesh.js';

self.onmessage = (e) => {
  const { id, buf, opts = {} } = e.data || {};
  try {
    const t0 = performance.now();
    const t = decodeTile(new Uint8Array(buf));
    // copies: the decoded views alias `buf`; the main thread keeps mask/height for heightAt / sdfAt queries
    const mask = t.mask ? t.mask.slice() : null, height = t.height ? t.height.slice() : null;
    const tile = { z: t.z, x: t.x, y: t.y, flags: t.flags, n: t.n, rev: t.rev, uniformH: t.uniformH, srcHash: t.srcHash, contentHash: t.contentHash, mask, height, src: t.vectors?.src ?? null, ov: t.vectors?.ov ?? null };
    const transfer = [];
    if (mask) transfer.push(mask.buffer, height.buffer);
    let terrain = null, structures = null, city = null, bytes = 0;
    if (opts.meshes !== false) {
      const src = { ...t, mask: t.mask, height: t.height };
      const r = buildTile(src, opts.city ? { ...opts, noBuildings: true } : opts);
      if (opts.city && t.z === 14 && t.mask) {
        try { city = buildCity(src, opts.city); } catch { city = null; }
        if (city) for (const a of [city.pos, city.nrm, city.col, city.fac, city.sty, city.idx, city.inst.trees, city.inst.boxes]) transfer.push(a.buffer);
      }
      terrain = r.terrain; structures = r.structures; bytes = r.bytes;
      for (const a of [terrain.pos, terrain.nrm, terrain.col, terrain.morph]) transfer.push(a.buffer);
      if (structures) {
        for (const a of [structures.pos, structures.nrm, structures.col, structures.idx]) transfer.push(a.buffer);
        for (const a of Object.values(structures.inst)) transfer.push(a.buffer);
      }
    }
    self.postMessage({ id, ok: true, tile, terrain, structures, city, bytes, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
