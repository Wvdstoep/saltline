// Pre-builds the world raster caches (also runs automatically on first server start).
import { World } from '../server/world.js';
import { HARBORS, carvingsForWorld } from '../server/harbors.js';
const t0 = Date.now();
const world = new World().load(carvingsForWorld());
console.log(`[build-world] done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
let bad = 0;
for (const h of HARBORS) {
  const d = world.depthAt(h.lat, h.lon);
  if (d < 9) { bad++; console.log(`  shallow/land at ${h.id}: depth ${d.toFixed(1)} m`); }
}
console.log(`[build-world] ${HARBORS.length - bad}/${HARBORS.length} harbours navigable`);
// Sanity checks on well-known points
const checks = [['North Sea centre', 55.5, 3.0, true], ['Paris', 48.86, 2.35, false], ['Atlantic', 40, -30, true], ['Sahara', 23, 10, false], ['Dover strait', 51.0, 1.5, true], ['Hamburg basin', 53.54, 9.92, true]];
for (const [n, la, lo, water] of checks) console.log(`  ${n}: h=${world.heightAt(la, lo).toFixed(1)} ${world.isWater(la, lo) === water ? 'OK' : 'MISMATCH'}`);
