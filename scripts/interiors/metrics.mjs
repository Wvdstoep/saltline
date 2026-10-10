// Interiors v2 — acceptance metrics (docs/INTERIORS-V2-CONTRACT.md §8.1–8.2, Lane T). Pure functions over a plan, and a
// CLI that prints today (v1) / v2 side by side and writes docs/interiors-v2/metrics.md (generated, not hand-edited).
//   node scripts/interiors/metrics.mjs [ids,…] [--write]
// Method (§8.2): per room a 0.25 m grid over the free floor (floor minus solid footprints whose span overlaps
// [y + 0.05, y + 1.7], minus cuts / floor holes); A2 = share of free floor within 2.0 m of a furniture / equipment
// solid (walls do not count, wall-mounted items do); A3 = largest empty disc (to solids or walls); A4 = fill.
import { SCALE, netArea, wetRange } from '../../shared/ships/gaspace.js';
import { ITEMS } from '../../public/js/iv2items.js';

const CELL = 0.25;
const CIRC = new Set(['corridor', 'corridor_pax', 'crew_alley', 'corridor_yacht', 'stair', 'entrance', 'cabin_lobby', 'cargo', 'open_deck', 'er_walkway']);
/** Rooms the metrics measure (§8.1): enclosed, walkable, not circulation / cargo / weather. v1 rooms by legacy kind. */
export function measured(plan) {
  return plan.rooms.filter((r) => !r.open && r.walk !== false && (r.space ? !CIRC.has(r.space) && !(r.space === 'lobby_pax' && area(r) < 20) : !['passage', 'stairs', 'deck'].includes(r.kind) && r.use !== 'hold' && r.use !== 'casing'));
}
export const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);

/** A2 / A3 / A4 of one room. */
export function roomMetrics(plan, r, index = null) {
  const nx = Math.max(1, Math.round((r.x1 - r.x0) / CELL)), nz = Math.max(1, Math.round((r.z1 - r.z0) / CELL)), N = nx * nz;
  const obs = new Uint8Array(N), item = new Uint8Array(N);
  const cx = (i) => r.x0 + (i + 0.5) * CELL, cz = (j) => r.z0 + (j + 0.5) * CELL;
  const solids = (index ? index(r) : plan.solids).filter((s) => s.y < r.y + 1.7 && s.y + s.h > r.y + 0.05 && s.x0 < r.x1 && s.x1 > r.x0 && s.z0 < r.z1 && s.z1 > r.z0);
  let foot = 0;
  for (const s of solids) {
    foot += (Math.min(s.x1, r.x1) - Math.max(s.x0, r.x0)) * (Math.min(s.z1, r.z1) - Math.max(s.z0, r.z0));
    for (let j = 0; j < nz; j++) { const z = cz(j); if (z < s.z0 || z > s.z1) continue; for (let i = 0; i < nx; i++) { const x = cx(i); if (x >= s.x0 && x <= s.x1) { obs[j * nx + i] = 1; item[j * nx + i] = 1; } } }
  }
  for (const h of [...(r.cuts || []), ...(r.floorHoles || [])]) for (let j = 0; j < nz; j++) { const z = cz(j); if (z < h.z0 || z > h.z1) continue; for (let i = 0; i < nx; i++) { const x = cx(i); if (x >= h.x0 && x <= h.x1) obs[j * nx + i] = 2; } }
  // the guard rails round floor openings (engine voids, stairwells) are equipment you stand beside (A2)
  for (const h of r.cuts || []) for (let j = 0; j < nz; j++) { const z = cz(j); if (z < h.z0 - CELL || z > h.z1 + CELL) continue; for (let i = 0; i < nx; i++) { const x = cx(i); if (x >= h.x0 - CELL && x <= h.x1 + CELL && obs[j * nx + i] !== 2) item[j * nx + i] = 1; } }
  // engine-room bays (§4.6): the largest disc is measured on bare floor — the walkways are circulation, like corridors
  const walk = new Uint8Array(N);
  if (r.space === 'er_platform') for (const h of r.walkways || []) for (let j = 0; j < nz; j++) { const z = cz(j); if (z < h.z0 || z > h.z1) continue; for (let i = 0; i < nx; i++) { const x = cx(i); if (x >= h.x0 && x <= h.x1 && !obs[j * nx + i]) walk[j * nx + i] = 1; } }
  // wall-mounted items (no solid) count for "near furniture" (A2)
  for (const p of plan.props) {
    if (p.t !== 'k2' || p.room !== r.id) continue;
    const it = ITEMS[p.item]; if (!it || it.solid === true || it.solid === 'low') continue;
    const w = p.w ?? it.w, d = p.d ?? it.d, rot = p.rotY || 0, ax = Math.abs(Math.sin(rot)) > 0.5;
    const hx = (ax ? d : w) / 2, hz = (ax ? w : d) / 2;
    for (let j = 0; j < nz; j++) { const z = cz(j); if (Math.abs(z - p.z) > hz + CELL / 2) continue; for (let i = 0; i < nx; i++) if (Math.abs(cx(i) - p.x) <= hx + CELL / 2) item[j * nx + i] = 1; }
  }
  // distance transforms (chamfer 1 / √2) in cells: dS to items, dW to items + cuts + walls
  const INF = 1e9, dS = new Float32Array(N), dW = new Float32Array(N), s2 = Math.SQRT2;
  for (let k = 0; k < N; k++) { dS[k] = item[k] ? 0 : INF; dW[k] = obs[k] || walk[k] ? 0 : INF; }
  const pass = (D, walls) => {
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; let v = D[k]; if (walls) v = Math.min(v, i + 0.5, j + 0.5); if (i) v = Math.min(v, D[k - 1] + 1); if (j) v = Math.min(v, D[k - nx] + 1); if (i && j) v = Math.min(v, D[k - nx - 1] + s2); if (i < nx - 1 && j) v = Math.min(v, D[k - nx + 1] + s2); D[k] = v; }
    for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) { const k = j * nx + i; let v = D[k]; if (walls) v = Math.min(v, nx - i - 0.5, nz - j - 0.5); if (i < nx - 1) v = Math.min(v, D[k + 1] + 1); if (j < nz - 1) v = Math.min(v, D[k + nx] + 1); if (i < nx - 1 && j < nz - 1) v = Math.min(v, D[k + nx + 1] + s2); if (i && j < nz - 1) v = Math.min(v, D[k + nx - 1] + s2); D[k] = v; }
  };
  pass(dS, false); pass(dW, true);
  let free = 0, near = 0, maxR = 0, at = -1;
  for (let k = 0; k < N; k++) { if (obs[k] || walk[k]) continue; free++; if (dS[k] * CELL <= 2.0) near++; if (dW[k] > maxR) { maxR = dW[k]; at = k; } }
  const A = area(r);
  return { id: r.id, space: r.space || r.kind, area: A, free: free * CELL * CELL, a2: free ? near / free : 1, emptyR: maxR * CELL, at: at < 0 ? null : { x: +(cx(at % nx)).toFixed(2), z: +(cz(Math.floor(at / nx))).toFixed(2) }, fill: Math.max(0, foot) / A, items: plan.props.filter((p) => p.t === 'k2' && p.room === r.id).length };
}

/** A spatial index of the plan's solids (rooms ask for their own). */
export function solidIndex(plan) {
  const grid = new Map(), C = 4;
  for (const s of plan.solids) for (let i = Math.floor(s.x0 / C); i <= Math.floor(s.x1 / C); i++) for (let j = Math.floor(s.z0 / C); j <= Math.floor(s.z1 / C); j++) { const k = i * 100003 + j; let l = grid.get(k); if (!l) { l = []; grid.set(k, l); } l.push(s); }
  return (r) => { const out = new Set(); for (let i = Math.floor(r.x0 / C); i <= Math.floor(r.x1 / C); i++) for (let j = Math.floor(r.z0 / C); j <= Math.floor(r.z1 / C); j++) for (const s of grid.get(i * 100003 + j) || []) out.add(s); return [...out]; };
}

/** Every acceptance check of §8.1 for one plan → { rooms: [...], ship: {...}, fails: [...] }. */
export function shipMetrics(plan, { ga = null } = {}) {
  const idx = solidIndex(plan), fails = [], rooms = [];
  for (const r of measured(plan)) {
    const m = roomMetrics(plan, r, idx); rooms.push(m);
    const k = SCALE[r.space];
    if (!k) continue;
    // A2 / A3 / A4 / A6 per room
    const pub = ['restaurant', 'buffet', 'cafeteria', 'bar', 'lounge_pax', 'casino', 'nightclub', 'theatre', 'shop', 'seats_lounge', 'kids', 'spa'].includes(r.space);
    if (m.a2 < 0.8) fails.push(`A2 ${r.id} (${r.space}) ${(m.a2 * 100).toFixed(0)} % of the floor within 2 m of furniture`);
    const cap = (r.exempt || []).reduce((c, e) => Math.max(c, e.cap), 0) || k.emptyR;
    if (m.emptyR > cap + CELL) fails.push(`A3 ${r.id} (${r.space}) empty disc r ${m.emptyR.toFixed(2)} > ${cap} at ${m.at?.x},${m.at?.z}`);
    if (r.space === 'er_platform' || r.space === 'bridge' || r.space === 'steering_gear') { if (m.fill < 0.04) fails.push(`A4 ${r.id} (${r.space}) fill ${(m.fill * 100).toFixed(0)} %`); }
    else if (m.fill < k.fill[0] * 0.5 || m.fill > k.fill[1] * 1.35) fails.push(`A4 ${r.id} (${r.space}) fill ${(m.fill * 100).toFixed(0)} % outside ${k.fill.map((v) => v * 100).join('–')} %`);
    if (k.berth && !String(r.space).startsWith('cabin_cruise') && m.items < 7) fails.push(`A6 ${r.id} (${r.space}) ${m.items} items (cabins ≥ 7)`);
    void pub;
  }
  // A1: scale — every v2 space within its band (net of the wet unit), door widths
  for (const r of plan.rooms) {
    const k = SCALE[r.space]; if (!k || k.circulation || r.open || r.walk === false || !k.max || !Number.isFinite(k.max)) continue;
    if (['er_platform', 'bridge', 'cargo', 'steering_gear', 'pump_room', 'bosun_store', 'atrium'].includes(r.space)) continue;
    if (r.space.startsWith('cabin') || r.space.startsWith('suite') || r.space === 'hospital' || r.space === 'mess' || r.space === 'galley' || ['office', 'laundry', 'gym', 'recreation', 'library', 'conference', 'changing_er', 'pantry', 'provisions_dry', 'cold_room', 'store_gen', 'linen', 'chartroom', 'radio_room', 'electronics', 'battery', 'wc_room', 'drying_room', 'smoke_room', 'lounge_crew', 'bonded_store', 'ac_room', 'fan_room', 'co2_room', 'paint_locker', 'hospital_bath', 'ccr'].includes(r.space)) {
      if (!r.v2recut && !String(r.zone).startsWith('house')) continue;
      const na = netArea(r.space, area(r));
      if (!na.ok && r.v2recut) fails.push(`A1 ${r.id} (${r.space}) ${area(r).toFixed(1)} m² (net ${na.net.toFixed(1)}) outside ${k.min}–${k.max}`);
    }
  }
  for (const d of plan.doors) if (d.w < 0.72) fails.push(`A1 door ${d.a}/${d.side} ${d.w} m`);
  // A5 waste per accommodation level (house tiers): box minus rooms (casing included)
  const waste = [];
  if (ga?.house) for (const t of ga.house.tiers) {
    const H = ga.house, box = (H.x1 - H.x0) * (H.z1 - H.z0);
    let used = 0; for (const r of plan.rooms) if (Math.abs(r.y - t.y) < 0.05 && r.x0 >= H.x0 - 0.01 && r.x1 <= H.x1 + 0.01 && r.z0 >= H.z0 - 0.01 && r.z1 <= H.z1 + 0.01 && !r.open) used += area(r);
    const w = Math.max(0, 1 - used / box); waste.push(w);
    if (w > 0.08) fails.push(`A5 tier ${t.id} waste ${(w * 100).toFixed(1)} %`);
  }
  for (const r of plan.rooms) if (/^(Spare cabin|Store room)$/.test(r.name) && !plan.props.some((p) => p.t === 'k2' && p.room === r.id)) fails.push(`A5 ${r.id} "${r.name}" without a kit`);
  // A6 unlined rooms: frames + ≥ 1 run
  for (const r of plan.rooms) { if (r.open || r.walk === false || r.lined !== false || !r.space || r.space === 'cargo') continue; const runs = plan.props.filter((p) => p.t === 'run' && p.room === r.id); if (!runs.some((p) => p.kind === 'frame') || runs.length < 2) fails.push(`A6 ${r.id} (${r.space}) frames/runs ${runs.length}`); }
  // A7 lights: ≥ 1 practical per measured room; exit sign in every stair room
  const lit = new Set((plan.lights || []).filter((l) => !l.em).map((l) => l.room));
  for (const r of plan.rooms) if (!r.open && r.walk !== false && r.space && !lit.has(r.id)) fails.push(`A7 ${r.id} (${r.space}) no light`);
  for (const r of plan.rooms) if (r.space === 'stair' && !plan.props.some((p) => p.t === 'k2' && p.item === 'exit_sign' && p.room === r.id)) fails.push(`A7 ${r.id} stair without an exit sign`);
  // A8 circulation: dead ends ≤ 7 m in corridors
  for (const r of plan.rooms) {
    if (r.space !== 'corridor' && r.space !== 'corridor_pax') continue;
    const alongX = r.x1 - r.x0 >= r.z1 - r.z0, lo = alongX ? r.x0 : r.z0, hi = alongX ? r.x1 : r.z1;
    const exits = plan.doors.filter((d) => (d.a === r.id || d.b === r.id) && (() => { const o = plan.rooms.find((q) => q.id === (d.a === r.id ? d.b : d.a)); return !o || o.open || ['corridor', 'corridor_pax', 'stair', 'entrance', 'cabin_lobby', 'bridge', 'crew_alley'].includes(o.space) || o.kind === 'stairs' || o.kind === 'passage'; })());
    const pos = exits.map((d) => { const along = (d.side === 'n' || d.side === 's') === alongX; return along ? d.at : (d.side === 'w' || d.side === 'n' ? lo : hi); });
    for (const s of plan.stairs) if (s.foot === r.id || s.head === r.id) pos.push(alongX ? (s.x0 + s.x1) / 2 : (s.z0 + s.z1) / 2);
    if (!pos.length) continue;
    const de = Math.max(Math.min(...pos) - lo, hi - Math.max(...pos));
    if (de > 7.05) fails.push(`A8 ${r.id} dead end ${de.toFixed(1)} m`);
  }
  // ship level A2 (area weighted; public venues ≥ 85 %)
  let fa = 0, na = 0; for (const m of rooms) { fa += m.free; na += m.free * m.a2; }
  const shipA2 = fa ? na / fa : 1;
  if (shipA2 < 0.9) fails.push(`A2 ship ${(shipA2 * 100).toFixed(1)} % (≥ 90 %)`);
  return { rooms, ship: { a2: shipA2, maxEmptyR: Math.max(0, ...rooms.map((m) => m.emptyR)), maxRoom: Math.max(0, ...plan.rooms.filter((r) => !r.open && r.walk !== false && !['cargo'].includes(r.space)).map(area)), waste: waste.length ? Math.max(...waste) : 0 }, fails };
}

/** The §0.2 comparison numbers of a plan (cabin floor, clear height, fill, near-share, largest disc, largest room). */
export function summary(plan) {
  const idx = solidIndex(plan), ms = measured(plan).map((r) => ({ r, m: roomMetrics(plan, r, idx) }));
  const cab = ms.filter(({ r }) => (r.space ? String(r.space).startsWith('cabin_') && r.space !== 'cabin_lobby' : r.kind === 'cabin' && r.use === 'cabin'));
  const er = ms.filter(({ r }) => r.zone === 'er' && (r.space ? r.space === 'er_platform' : r.kind === 'engine'));
  const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : 0);
  const wavg = (a) => { let A = 0, S = 0; for (const { m } of a) { A += m.free; S += m.free * m.a2; } return A ? S / A : 1; };
  return {
    cabinArea: avg(cab, ({ r }) => area(r)), cabinH: avg(cab, ({ r }) => r.h), cabinFill: avg(cab, ({ m }) => m.fill),
    near2All: wavg(ms), near2ER: wavg(er), emptyER: Math.max(0, ...er.map(({ m }) => m.emptyR)), emptyAll: Math.max(0, ...ms.map(({ m }) => m.emptyR)),
    maxRoom: Math.max(0, ...plan.rooms.filter((r) => !r.open && r.walk !== false && r.use !== 'hold' && r.space !== 'cargo').map(area)),
  };
}

// ------------------------------------------------------------------------------------------------ CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { planFromGA } = await import('../../public/js/gaplan.js');
  const { MODELS } = await import('../../shared/ships/catalogue.js');
  const { generalArrangement } = await import('../../shared/ships/ga.js');
  const { IV2_READY } = await import('../../shared/ships/gaspace.js');
  const arg = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const ids = arg[0] ? arg[0].split(',') : Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail' && IV2_READY.has(MODELS[k].gen));
  const rows = [];
  for (const id of ids) {
    const v1 = summary(planFromGA(id, { v: 1 })), p2 = planFromGA(id), v2 = summary(p2), acc = shipMetrics(p2, { ga: generalArrangement(id) });
    rows.push({ id, v1, v2, fails: acc.fails.length });
    console.log(`${id.padEnd(16)} cabin ${v1.cabinArea.toFixed(1)}→${v2.cabinArea.toFixed(1)} m²  h ${v1.cabinH.toFixed(2)}→${v2.cabinH.toFixed(2)}  fill ${(v1.cabinFill * 100).toFixed(0)}→${(v2.cabinFill * 100).toFixed(0)} %  near2 ${(v1.near2All * 100).toFixed(0)}→${(v2.near2All * 100).toFixed(0)} % (ER ${(v1.near2ER * 100).toFixed(0)}→${(v2.near2ER * 100).toFixed(0)})  disc ER ${v1.emptyER.toFixed(1)}→${v2.emptyER.toFixed(1)} m  max room ${v1.maxRoom.toFixed(0)}→${v2.maxRoom.toFixed(0)} m²  fails ${acc.fails.length}`);
  }
  if (process.argv.includes('--write')) {
    const fs = await import('node:fs');
    const f = (v, d = 1) => v.toFixed(d);
    const md = ['# Interiors v2 — metrics (generated by scripts/interiors/metrics.mjs; do not edit)', '', '| Model | Cabin floor m² (v1 → v2) | Cabin clear h m | Cabin fill % | Free floor ≤ 2 m of furniture % (all / ER) | Largest empty disc in ER m | Largest room m² | Acceptance fails |', '|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.id} | ${f(r.v1.cabinArea)} → ${f(r.v2.cabinArea)} | ${f(r.v1.cabinH, 2)} → ${f(r.v2.cabinH, 2)} | ${f(r.v1.cabinFill * 100, 0)} → ${f(r.v2.cabinFill * 100, 0)} | ${f(r.v1.near2All * 100, 0)}/${f(r.v1.near2ER * 100, 0)} → ${f(r.v2.near2All * 100, 0)}/${f(r.v2.near2ER * 100, 0)} | ${f(r.v1.emptyER)} → ${f(r.v2.emptyER)} | ${f(r.v1.maxRoom, 0)} → ${f(r.v2.maxRoom, 0)} | ${r.fails} |`)];
    fs.mkdirSync(new URL('../../docs/interiors-v2/', import.meta.url), { recursive: true });
    fs.writeFileSync(new URL('../../docs/interiors-v2/metrics.md', import.meta.url), md.join('\n') + '\n');
    console.log('wrote docs/interiors-v2/metrics.md');
  }
}
export { wetRange };
