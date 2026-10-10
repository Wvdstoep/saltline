// Interiors v2 — render budgets (docs/INTERIORS-V2-CONTRACT.md §6, A9; Lane R): three.js in node with the game's
// Interior (the interiors2-budget pattern) and buildInteriorV2 for phase-1 models. For every zone a walker can stand
// in, standing at each detail chunk's centre, what frameV2 shows — the zone's shell, its nearest chunks at LOD0 (desktop
// ≤ 10 within 15 m, phone ≤ 2 within 8 m) and the rest at LOD1 (phones: near ones only), plus the shells of the zones
// visibleZones() adds and of window views with their one-mesh LOD1 (desktop) — stays
// within desktop ≤ 160k triangles / ≤ 90 draw calls and phone ≤ 55k / ≤ 40. Also: ≤ 5 materials, shell build time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`const ROOT=${JSON.stringify(ROOT)};export async function resolve(s,c,n){if(s.startsWith('/shared/'))return n(ROOT+s.slice(1),c);if(s.startsWith('/js/'))return n(ROOT+'public'+s,c);return n(s,c);}`));
const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
if (!('document' in globalThis)) globalThis.document = { getElementById: () => null, createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }) };

const THREE = await import('three');
const { Interior } = await import('../public/js/interior.js');
const { planFromGA } = await import('../public/js/gaplan.js');
const { buildInteriorV2, v2Materials } = await import('../public/js/iv2draw.js');
const { visibleZones } = await import('../public/js/gaprops.js');
const { MODELS } = await import('../shared/ships/catalogue.js');
const { IV2_READY } = await import('../shared/ships/gaspace.js');

const ALL = Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail' && IV2_READY.has(MODELS[k].gen));
const IDS = process.env.IV2_BUDGET_ALL ? ALL : ['coaster', 'feeder', 'ultramax64', 'mr50', 'ulcv24k', 'vlcc300', 'lng174k', 'capesize180'].filter((k) => ALL.includes(k));
const BUDGET = { desk: { tris: 160000, calls: 90, hi: 10 }, phone: { tris: 55000, calls: 40, hi: 2 } };

const count = (o) => { let tris = 0, calls = 0; o.traverse((m) => { if (m.isMesh) { calls++; const g = m.geometry; tris += (m.isInstancedMesh ? m.count : 1) * (g.index ? g.index.count : g.attributes.position.count) / 3; } }); return { tris, calls }; };
function measure(id, phone) {
  const plan = planFromGA(id);
  const it = Object.create(Interior.prototype); it.textures = []; it.app = { scene: new THREE.Scene() }; it.mats = it.makeMaterials(plan.style);
  const t0 = performance.now();
  const groups = buildInteriorV2(it, plan, new THREE.Group(), { phone });
  const ms = performance.now() - t0;
  const Z = new Map();
  for (const [z, g] of groups) {
    const zz = it.v2.zones.get(z); const shell = { tris: 0, calls: 0 };
    for (const c of g.children) if (c.isMesh) { const q = count(c); shell.tris += q.tris; shell.calls += q.calls; }
    const chunks = [...(zz?.chunks?.entries() || [])].map(([cid, c]) => ({ cid, center: c.center, hi: count(c.hi), lo: count(c.lo) }));
    Z.set(z, { shell, chunks, far: zz?.far ? count(zz.far) : { tris: 0, calls: 0 } });
  }
  // stand at every chunk centre (and the zone's first room when it has no chunks) and apply frameV2's rules
  const B = phone ? BUDGET.phone : BUDGET.desk, range = phone ? 8 : 15;
  const standable = new Set(plan.rooms.filter((r) => r.walk !== false).map((r) => r.zone || 'deck'));
  let worst = { tris: 0, calls: 0, zone: null };
  for (const z of standable) {
    const q0 = Z.get(z); if (!q0) continue;
    const r0 = plan.rooms.find((r) => (r.zone || 'deck') === z && r.walk !== false);
    const spots = q0.chunks.length ? q0.chunks.map((c) => ({ cur: c.cid, p: c.center })) : [{ cur: null, p: { x: (r0.x0 + r0.x1) / 2, y: r0.y, z: (r0.z0 + r0.z1) / 2 } }];
    const vis = new Set(visibleZones(plan, z, phone));
    for (const v of plan.views || []) if (plan.rooms.find((r) => r.id === v.room)?.zone === z) for (const w of v.zones) vis.add(w);
    for (const { cur, p } of spots) {
      let tris = 0, calls = 0;
      for (const v of vis) {
        const q = Z.get(v); if (!q) continue;
        tris += q.shell.tris; calls += q.shell.calls;
        if (v !== z) { if (!phone) { tris += q.far.tris; calls += q.far.calls; } continue; }
        const list = q.chunks.map((c) => [c, c.cid === cur ? -1 : (c.center ? Math.hypot(c.center.x - p.x, (c.center.y - p.y) * 2, c.center.z - p.z) : 999)]).sort((a, b) => a[1] - b[1]);
        let n = 0;
        for (const [c, d] of list) {
          const hi = c.cid === cur || (d < range && n < B.hi); if (hi) n++;
          const lo = !hi && (!phone || d < range * 2);
          if (hi) { tris += c.hi.tris; calls += c.hi.calls; } else if (lo) { tris += c.lo.tris; calls += c.lo.calls; }
        }
      }
      if (tris > worst.tris) worst = { ...worst, tris, zone: z };
      worst.calls = Math.max(worst.calls, calls);
    }
  }
  return { worst, ms, it };
}

test('render: five materials, one atlas', () => {
  const S = v2Materials(false);
  assert.ok(Object.keys(S.mats).length <= 5, `${Object.keys(S.mats).length} materials`);
});

test('render: every standable zone within the desktop and phone budgets', () => {
  const rows = [], bad = [];
  for (const id of IDS) {
    const d = measure(id, false), p = measure(id, true);
    rows.push(`${id.padEnd(12)} desk ${Math.round(d.worst.tris / 1000)}k/${d.worst.calls} (${d.worst.zone})  phone ${Math.round(p.worst.tris / 1000)}k/${p.worst.calls} (${p.worst.zone})  build ${d.ms.toFixed(0)} ms`);
    if (d.worst.tris > BUDGET.desk.tris || d.worst.calls > BUDGET.desk.calls) bad.push(`${id} desktop ${d.worst.tris}/${d.worst.calls}`);
    if (p.worst.tris > BUDGET.phone.tris || p.worst.calls > BUDGET.phone.calls) bad.push(`${id} phone ${p.worst.tris}/${p.worst.calls}`);
  }
  console.log(rows.map((r) => `# ${r}`).join('\n'));
  assert.deepEqual(bad, []);
});

test('render: doors are instanced leaves the animator can drive', () => {
  const { it } = measure('mr50', false);
  assert.ok(it.v2.doors.length > 20, `${it.v2.doors.length} doors`);
  const dd = it.v2.doors[0]; it.v2.setDoor ? it.v2.setDoor(dd, 1) : null;
  assert.ok(dd.mesh?.isInstancedMesh, 'instanced');
});
