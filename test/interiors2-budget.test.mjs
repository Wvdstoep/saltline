// Lane C budgets (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6.6): planFromGA time and room count per plan, and the
// interior geometry the walker sees — the zone it stands in plus what visibleZones() adds — built with three.js and the
// game's own Interior drawing (plus gaprops.js), for every catalogue ship: desktop ≤ 200k tris / ≤ 200 draw calls,
// phone ≤ 60k tris / ≤ 80 draw calls (cruise ships: one deck, streamed by tower section).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// interior.js imports '/shared/…' and '/js/…' as the browser sees them: map those onto the repo for node
const ROOT = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`const ROOT=${JSON.stringify(ROOT)};export async function resolve(s,c,n){if(s.startsWith('/shared/'))return n(ROOT+s.slice(1),c);if(s.startsWith('/js/'))return n(ROOT+'public'+s,c);return n(s,c);}`));
// a canvas that draws nothing (labels, gauges): enough for Interior's materials and props outside a browser
const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const hadDoc = 'document' in globalThis;
if (!hadDoc) globalThis.document = { getElementById: () => null, createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }) };

const THREE = await import('three');
const { Interior } = await import('../public/js/interior.js');
const { planFromGA } = await import('../public/js/gaplan.js');
const { drawGAProp, GA_PROP_KINDS, buildZoned, visibleZones } = await import('../public/js/gaprops.js');
const { generalArrangement } = await import('../shared/ships/ga.js');
const { MODELS } = await import('../shared/ships/catalogue.js');

const IDS = Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail');
const BUDGET = { desk: { tris: 200000, calls: 200 }, phone: { tris: 60000, calls: 80 } };
const PLAN_MS = 30, PLAN_MS_SLACK = Number(process.env.GA_PLAN_SLACK || 4);   // CI boxes are shared: 4 × the budget fails

/** Interior with the phase-2 prop hook (H11) — built without its DOM / input constructor. */
class GAI extends Interior { drawProp(ctx, p) { if (GA_PROP_KINDS.has(p.t) && drawGAProp(ctx, p)) return; return super.drawProp(ctx, p); } }
function zoneGeometry(plan) {
  const it = Object.create(GAI.prototype); it.textures = []; it.app = { scene: new THREE.Scene() };
  it.mats = it.makeMaterials(plan.style);
  const groups = buildZoned(it, plan, new THREE.Group());
  const per = new Map();
  for (const [z, g] of groups) { let tris = 0, calls = 0; g.traverse((o) => { if (o.isMesh) { calls++; const q = o.geometry; tris += (q.index ? q.index.count : q.attributes.position.count) / 3; } }); per.set(z, { tris, calls }); }
  return per;
}
function worstView(plan, per, phone) {
  let worst = { tris: 0, calls: 0, zone: null };
  for (const z of per.keys()) {
    let tris = 0, calls = 0; for (const v of visibleZones(plan, z, phone)) { const q = per.get(v); if (q) { tris += q.tris; calls += q.calls; } }
    if (tris > worst.tris) worst = { ...worst, tris, zone: z };
    worst.calls = Math.max(worst.calls, calls);
  }
  return worst;
}
const plansOf = (id) => { const p = planFromGA(id); if (!p.deckGroup) return [p]; return generalArrangement(id).pax.decks.map((d) => planFromGA(id, { deck: d.id })); };

test('budget: planFromGA time and ≤ 400 rooms for every model (cruise / ro-pax: every deck plan)', () => {
  const slow = [];
  for (const id of IDS) {
    const ga = generalArrangement(id);
    const decks = ga.pax && planFromGA(ga).deckGroup ? ga.pax.decks.map((d) => d.id) : [null];
    for (const deck of decks) {
      // CPU time of the best of three runs: wall time on a shared, loaded box measures the neighbours
      let ms = Infinity, p = null;
      for (let k = 0; k < 4; k++) { const c0 = process.cpuUsage(); p = planFromGA(ga, { deck }); const c = process.cpuUsage(c0); if (k) ms = Math.min(ms, (c.user + c.system) / 1000); }
      assert.ok(p.rooms.length <= 400, `${id}${deck ? '/' + deck : ''}: ${p.rooms.length} rooms`);
      if (ms > PLAN_MS) slow.push(`${id}${deck ? '/' + deck : ''} ${ms.toFixed(1)} ms`);
      assert.ok(ms <= PLAN_MS * PLAN_MS_SLACK, `${id}${deck ? '/' + deck : ''}: planFromGA ${ms.toFixed(1)} ms (budget ${PLAN_MS} ms)`);
    }
  }
  if (slow.length) console.log(`# over ${PLAN_MS} ms on this machine (within slack): ${slow.join(', ')}`);
});

test('budget: every zone a walker can stand in stays within the desktop and phone triangle / draw-call limits', () => {
  for (const id of IDS) for (const plan of plansOf(id)) {
    const per = zoneGeometry(plan);
    const tag = `${id}${plan.deckGroup ? '/' + plan.deckGroup : ''}`;
    for (const z of plan.zones) assert.ok(per.has(z.id), `${tag}: zone ${z.id} has no group`);
    for (const k of ['rooms', 'stairs', 'props', 'solids', 'hotspots']) for (const o of plan[k]) if (o.zone) assert.ok(per.has(o.zone), `${tag}: ${k} item in unknown zone ${o.zone}`);
    for (const [view, lim] of Object.entries(BUDGET)) {
      const w = worstView(plan, per, view === 'phone');
      assert.ok(w.tris <= lim.tris, `${tag} ${view}: ${Math.round(w.tris / 1000)}k tris in ${w.zone} (≤ ${lim.tris / 1000}k)`);
      assert.ok(w.calls <= lim.calls, `${tag} ${view}: ${w.calls} draw calls (≤ ${lim.calls})`);
    }
  }
});

test('budget: tall houses stream by tier and cruise decks by tower section (zones + visibleZones)', () => {
  const u = planFromGA('ulcv24k');
  const tiers = u.zones.filter((z) => z.group === 'house');
  assert.ok(tiers.length >= 8, `ulcv24k house zones ${tiers.length}`);
  const top = tiers.sort((a, b) => a.y0 - b.y0).at(-1);
  const ph = visibleZones(u, top.id, true), dk = visibleZones(u, top.id, false);
  assert.ok(ph.size <= 3 && !ph.has('er'), `phone on the bridge sees ${[...ph]}`);
  assert.ok(dk.size > ph.size && dk.has('deck'), `desktop on the bridge sees ${[...dk]}`);
  const c = planFromGA('cruise362');
  const secs = c.zones.filter((z) => z.group === `deck:${c.deckGroup}`);
  assert.ok(secs.length >= 4, `cruise sections ${secs.length}`);
  const mid = secs[2], v = visibleZones(c, mid.id, true);
  assert.ok(v.has(mid.id) && v.size === 3 && [...v].every((q) => q.startsWith(`deck:${c.deckGroup}`)), `phone in a cruise section sees ${[...v]}`);
  // walking still sees one map: the zone split changes drawing only
  assert.ok(c.rooms.every((r) => typeof r.zone === 'string'));
});
