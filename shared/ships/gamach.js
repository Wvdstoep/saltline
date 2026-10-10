// Interiors v2 — machinery and deck (docs/INTERIORS-V2-CONTRACT.md §2.3, §4.6, Lane M). Pure, deterministic.
//   frameSpacing(L)             standard frame spacing s = min(0.85, 0.002 L + 0.48) m (class-rule practice, S34 ≈)
//   meDetail(ga)                main engine: cylinders and turbochargers (2-stroke) / L or V layout (4-stroke) (S36 ≈)
//   erEquipment(ga, params)     what the engine room holds before placement: [{ item, n, sys, level?, near? }]
//   erBays(ga)                  each ER level cut into bays ≤ 12 m along z (web-frame aligned)
//   machineryPlan(variantId)    MachPlan: bays, the equipment demand with systems, overhaul area, deck gear, cargo views
// The equipment is placed on the walkable plan by the er_platform kit (public/js/iv2kits.js), which keeps the walkways,
// stair landings, ladders and hotspots clear; the resulting positions are the plan's `k2` props (§9.4).
import { generalArrangement } from './ga.js';
import { modelParams } from './gaparams.js';

export function frameSpacing(L) { return Math.round(Math.min(0.85, 0.002 * L + 0.48) * 1000) / 1000; }

/** kW per engine of a GA (installed power ÷ engines). */
function kwPerEngine(ga) { const n = ga.er?.me?.n || 1; return (ga.kW || 1000) / n; }

/** Main engine detail (§4.6 item 1). */
export function meDetail(ga) {
  const me = ga.er?.me || { kind: '4s', n: 1 };
  const kw = kwPerEngine(ga);
  if (me.kind === '2s') {
    const cyl = kw < 5000 ? 5 : kw < 17000 ? 6 : kw < 26000 ? 7 : kw < 34000 ? 8 : kw < 42000 ? 9 : kw < 50000 ? 10 : kw < 62000 ? 11 : 12;
    const total = ga.kW || kw;
    const tc = total <= 20000 ? 1 : total <= 45000 ? 2 : 3;
    return Object.freeze({ kind: '2s', n: me.n || 1, cyl, tc, layout: 'inline', parts: Object.freeze(['bedplate', 'aframe', 'block', 'covers', 'exh_receiver', 'turbo', 'scav_cooler', 'hcu']) });
  }
  const [cyl, layout] = kw <= 2000 ? [6, 'inline'] : kw <= 3500 ? [8, 'inline'] : kw <= 4500 ? [9, 'inline'] : kw <= 9000 ? [12, 'V'] : kw <= 13000 ? [16, 'V'] : [20, 'V'];
  return Object.freeze({ kind: me.de ? 'de' : '4s', n: me.n || 1, cyl, tc: layout === 'V' ? 2 : 1, layout, parts: Object.freeze(['block', 'heads', 'rockers', 'turbo', 'cac', 'flywheel']) });
}

/** The engine-room equipment list before placement (§4.6 item 2; Game rule counts). */
export function erEquipment(ga, params = null) {
  const p = params || modelParams(ga.id) || {};
  const kw = ga.kW || 1000, gt = ga.gt || 1000, big = (ga.L || 50) >= 120;
  const fuel = p.fuel || 'hfo';
  const out = [];
  const add = (item, n, sys, o = {}) => { if (n > 0) out.push(Object.freeze({ item, n, sys: Object.freeze(sys), ...o })); };
  // pumps on the floor (heavy sea-water / ballast / fire / bilge), FW and LO near the engine
  add('pump_v', 2 + (kw > 15000 ? 1 : 0), ['sw'], { level: 0, label: 'Sea-water cooling pump' });
  add('pump_v', 2 + 2, ['fw'], { level: 0, label: 'Fresh-water cooling pump (HT / LT)' });
  add('pump_h', 2, ['lo'], { level: 0, label: 'Lube-oil pump' });
  add('pump_h', big ? 2 : 1, ['ballast'], { level: 0, label: 'Ballast pump' });
  add('pump_v', 1, ['bilge'], { level: 0, label: 'Bilge pump' });
  add('pump_v', 2, ['fire'], { level: 0, label: 'Fire pump' });
  add('pump_v', 1, ['gs'], { level: 0, label: 'General-service pump' });
  add('cooler_plate', big ? 4 : 2, ['fw', 'sw'], { level: 0, label: 'Central cooler' });
  add('air_compressor', 2, ['air'], { level: 0 });
  add('air_receiver', 2, ['air'], { level: 0 });
  add('fw_generator', 1, ['fw', 'sw'], { level: 0 });
  add('sewage_plant', 1, ['bilge'], { level: 0 });
  add('ows', 1, ['bilge'], { level: 0, label: 'Oily-water separator' });
  if (gt >= 3000) add('incinerator', 1, ['fuel'], { level: 1 });
  add('hydrophore', 2, ['fw'], { level: 0 });
  add('fuel_module', fuel === 'mgo' ? 0 : 1, ['fuel'], { level: 1 });
  add('heater_skid', fuel === 'hfo' ? 2 : 0, ['steam', 'fuel'], { level: 1 });
  // tank faces on the wing bulkheads (service ×2, settling ×2, LO, sludge)
  add('tank_wall', 2, ['fuel'], { level: 1, label: 'Fuel service tank' });
  add('tank_wall', 2, ['fuel'], { level: 2, label: 'Fuel settling tank' });
  add('tank_wall', 1, ['lo'], { level: 1, label: 'Lube-oil storage tank' });
  add('tank_wall', 1, ['bilge'], { level: 0, label: 'Sludge tank' });
  add('spares_rack', big ? 4 : 2, [], { level: 1 });
  add('fire_station', 4, ['fire'], {});
  add('local_stand', 1, [], { level: 0 });
  add('mcc_panel', big ? 3 : 1, ['elec'], { level: 1, label: 'Motor control centre' });
  if (p.scrubber) add('pump_v', 2, ['sw'], { level: 2, label: 'Scrubber pump' });
  if (fuel === 'lng' || fuel === 'meoh') add('skid', 1, ['fuel'], { level: 2, label: fuel === 'lng' ? 'Gas valve unit' : 'Methanol fuel preparation skid' });
  return Object.freeze(out);
}

/** Each ER level cut into bays ≤ 12 m along z, aligned to web frames (every 4 frames). */
export function erBays(ga) {
  const er = ga.er; if (!er) return [];
  const s = frameSpacing(ga.L), web = 4 * s;
  const len = er.z1 - er.z0, n = Math.max(1, Math.ceil(len / 12));
  const step = Math.max(web, Math.min(Math.round(len / n / web), Math.floor(12 / web)) * web);
  const out = [];
  er.levels.forEach((y, level) => { for (let z = er.z0; z < er.z1 - 0.5; z += step) out.push({ level, y, z0: Math.round(z * 100) / 100, z1: Math.round(Math.min(er.z1, z + step) * 100) / 100 }); });
  return out;
}

const cache = new Map();
/** MachPlan (§9.3): the engine room's bays and equipment demand, the overhaul area, deck gear and cargo views. */
export function machineryPlan(variantId) {
  if (cache.has(variantId)) return cache.get(variantId);
  const ga = generalArrangement(variantId);
  if (!ga || ga.gen === 'sail' || !ga.er) { cache.set(variantId, null); return null; }
  const p = modelParams(variantId), me = meDetail(ga);
  const bays = erBays(ga).map((b) => ({ ...b, walk: [], voids: [] }));
  const equip = [];
  let k = 0;
  for (const e of erEquipment(ga, p)) for (let i = 0; i < e.n; i++) equip.push({ id: `eq${k++}`, item: e.item, x: null, y: ga.er.levels[e.level ?? 0] ?? ga.er.floorY, z: null, rotY: 0, w: null, d: null, h: null, sys: e.sys, level: e.level ?? 0, label: e.label || null });
  const meZ = ga.er.me.z, meLen = ga.er.me.len;
  const overhaul = { level: 0, x0: ga.er.me.w / 2 + 1.2, x1: ga.er.me.w / 2 + 4.2, z0: meZ - Math.min(2, meLen / 4), z1: meZ + Math.min(2, meLen / 4) };
  const gear = (ga.deck?.mooring || []).map((m, i) => ({ id: `dg${i}`, item: m.kind === 'windlass' ? 'windlass' : 'mooring_winch', x: null, y: m.y, z: m.z, rotY: 0, sys: [], level: null }));
  const holds = ga.cargo?.zones?.filter((z) => z.hatch || z.rows) || [];
  const tanks = ga.cargo?.kind === 'tanks' || ga.cargo?.kind === 'membrane' ? ga.cargo.zones.map((z) => ({ peek: { x: (ga.cargo.pipes?.w || 2) / 2 + 0.6, y: ga.deckY + 1.6, z: z.z0 + Math.min(3, (z.z1 - z.z0) * 0.25), yaw: 0, pitch: -1.1 }, box: { z0: z.z0, z1: z.z1 } })) : [];
  const mp = deepFreeze({ me, er: { bays, equip, runs: [], overhaul }, deck: { gear }, views: { holds: holds.map((h) => ({ z0: h.z0, z1: h.z1 })), tanks } });
  cache.set(variantId, mp);
  return mp;
}
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }

/** ISO 14726 identification colours by piping system (S35 ≈). */
export const SYS_COLOR = Object.freeze({ fuel: 0x7a4a24, lo: 0xd8b21c, fw: 0x2c6fd0, sw: 0x2f8f3e, fire: 0xc0392b, steam: 0xc7ccd1, air: 0x8ec9ee, bilge: 0x1e1e1e, ballast: 0x2f8f3e, gs: 0x2f8f3e, elec: 0x666666, cargo: 0x7a4a24 });
