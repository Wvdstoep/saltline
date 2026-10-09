// World politics, client lane: the HTML builders (public/js/politicsview.js) and the chart overlay
// (public/js/politicschart.js) rendered from the REAL dataset and REAL engine payloads (server/politics.js with a
// fake game). Structure and wording only: values come from the data, so a data refresh never breaks these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../public/js/politicsview.js';
import * as C from '../public/js/politicschart.js';
import * as F from '../public/js/politicsfmt.js';
import { DISCLAIMER, makeCtx, riskCheck, jobCheck, harbourRules } from '../shared/politics.js';
import { Politics } from '../server/politics.js';
import { diplomaticJobs } from '../server/politicsjobs.js';
import { HARBORS } from '../server/harbors.js';
import { bannedHits } from '../scripts/politics/validate.mjs';

// Same list as test/politics-wording.test.mjs (copied: importing a test file would run its tests here).
const PERSON_NAMES = ['putin', 'zelensky', 'zelenskyy', 'biden', 'trump', 'xi jinping', 'netanyahu', 'khamenei', 'pezeshkian', 'erdogan', 'erdoğan', 'macron', 'starmer', 'merz', 'scholz', 'modi', 'lula', 'maduro', 'lukashenko', 'kim jong un'];
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0) / 1000;
const game = { simTime: T0, rnd: () => 0.5, event() {}, send() {}, sink() {}, impound() {}, log() {}, harbors: {} };
const pol = new Politics(game, { harbors: HARBORS });
const ds = pol.ds;
const H = (id) => HARBORS.find((h) => h.id === id);
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const neutral = (html, where) => assert.deepEqual(bannedHits(text(html), PERSON_NAMES), [], where);
function player(id, home, at, o = {}) {
  const p = { id, name: id, company: `${id} Lines`, money: 500000, office: { home } };
  p.fleet = [{ id: `${id}v1`, name: 'Sea Lark', ship: { cls: o.cls || 'coaster', lat: at.lat, lon: at.lon, spd: 0 }, cond: o.cond ?? 78, cargo: o.cargo || [], jobs: o.jobs || [], docked: at.id }];
  p.aboard = `${id}v1`;
  pol.migrate(p);
  return p;
}
const A = player('pA', 'rotterdam', H('istanbul'), { cargo: [{ good: 'steel', qty: 120, origin: 'RU', jobId: null }, { good: 'fuel', qty: 40, origin: 'NL', jobId: null }],
  jobs: [{ id: 'jh1', type: 'freight', title: 'Freight 800 t grain Rotterdam → Havana', from: 'rotterdam', to: 'havana', good: 'grain', qty: 800, pay: 64000 }] });
const B = player('pB', 'novorossiysk', H('istanbul'));
const ctxOf = (p) => { const v = pol.youView(p).ctx; return makeCtx(ds, { home: v.home, flag: v.flag, rep: v.rep, cargo: pol.vesselOf(p).cargo, simTime: T0 }); };
/** Every linked source id ('data-src') has its entry in the same panel's source list ('polsrc-…'). */
function linksResolve(html, where) {
  const links = [...html.matchAll(/data-src="([^"]+)"/g)].map((m) => m[1]);
  const ids = new Set([...html.matchAll(/id="polsrc-([^"]+)"/g)].map((m) => m[1]));
  for (const l of links) assert.ok(ids.has(l), `${where}: source ${l} is linked but not listed`);
  return links.length;
}

test('every harbour gets a Rules tab: disclaimer, version, valid-as-of, neutral text, resolvable sources', () => {
  let links = 0;
  for (const h of HARBORS) {
    const r = pol.harbourPayload(A, h);
    const html = V.rulesTabHTML(r, { ds, nowS: T0, harborName: h.name, company: 'Saltline Shipping', extraBlocked: V.sellBlocks(ds, ctxOf(A), h.id) });
    const t = text(html);
    assert.ok(t.includes(DISCLAIMER), h.id);
    assert.ok(t.includes(`dataset ${ds.meta.version}`) && t.includes(`valid as of ${F.fmtDate(ds.meta.validAsOf)}`), h.id);
    for (const k of ['Port status', 'For your company', 'Customs and duties', 'Port state control', 'Environment', 'Security', 'Coastal trade', 'Sources']) assert.ok(t.includes(k), `${h.id}: ${k}`);
    // harbour names are real place names and may hold a banned substring ('Libreville' ⊃ 'evil'): check our text without them
    neutral(html.split(h.name).join(' ').split(h.name.split(' (')[0]).join(' '), h.id);
    links += linksResolve(html, h.id);
    const phone = V.rulesTabHTML(r, { ds, nowS: T0, phone: true });
    assert.equal((phone.match(/<details class="card polCard[^"]*" data-polcard="\w+" open>/g) || []).length, 2, `${h.id}: phones open only Port status and For your company`);
  }
  assert.ok(links > HARBORS.length, 'source tags are rendered');
});

test('Odesa: restricted, corridor + clearance, the per-ship premium, game-rule tags, conflict context line', () => {
  const r = pol.harbourPayload(A, H('odesa'));
  const html = V.rulesTabHTML(r, { ds, nowS: T0, harborName: 'Odesa' }), t = text(html);
  assert.match(t, /Restricted — corridor route required/);
  assert.match(html, /data-pol="clearance" data-harbor="odesa"/);
  assert.match(html, /data-pol="showCorridor" data-area="ua-corridor"/);
  assert.ok(t.includes(`${F.fmtCr(r.security[0].premium)}`), 'premium for this ship');
  assert.ok(t.includes('Game rule'));
  assert.match(t, /Country context: Armed conflict affecting shipping in .+ \(source: .+, \d\d \w{3} \d{4}\)\./);
  assert.match(t, /Listed area — .+ \(.+, \d\d \w{3} \d{4}\)/, 'area chip template');
  assert.deepEqual(F.quickTile(r).tone, 'warn');
});

test('For your company: an NL company sees the EU goods bans at a Russian port; an RU-flag ship sees the EU port ban at Rotterdam', () => {
  const r = pol.harbourPayload(A, H('ust_luga'));
  const html = V.rulesTabHTML(r, { ds, nowS: T0, extraBlocked: V.sellBlocks(ds, ctxOf(A), 'ust_luga') }), t = text(html);
  assert.match(t, /Buy: Steel coils — .*833\/2014/);
  assert.match(t, /Sell: Machinery — /);
  const rb = pol.harbourPayload(B, H('rotterdam'));
  const tb = text(V.rulesTabHTML(rb, { ds, nowS: T0 }));
  assert.match(tb, /This port refuses your ship/);
  assert.match(tb, /port control refuses entry: .*3ea/);
  assert.equal(F.quickTile(rb).tone, 'bad');
  const seiz = text(V.rulesTabHTML(pol.harbourPayload(A, H('rotterdam')), { ds, nowS: T0 }));
  assert.match(seiz, /Cargo aboard that this port seizes on entry: ✖ Steel coils \(origin RU\)/);
});

test('risk check card: Istanbul → Odesa along the corridor; a blocked contract disables Go; plan-around only with listed areas', () => {
  const ist = H('istanbul'), corridor = ds.areaById['ua-corridor'].line.map(([lo, la]) => [la, lo]);
  const ctx = ctxOf(A), v = { cls: 'coaster', cond: 78 };
  const rep = riskCheck(ds, ctx, { route: { from: { lat: ist.lat, lon: ist.lon }, points: corridor }, speedKn: 11.9, cls: 'coaster', cond: 78, toHarbor: 'odesa', vessel: v });
  const html = V.riskCheckHTML(rep, { ds, nowS: T0, title: 'Istanbul → Odesa', toName: 'Odesa', policy: 'avoid', policyText: V.policyVerdict(ds, 'avoid', rep.lines.map((l) => l.id)), coverAreas: V.coverAreas(ds, rep, 'coaster', 78), ecaCostCr: V.ecaCostFor(rep, 'coaster', 11.9, 78) });
  const t = text(html);
  assert.match(t, /Destination · Odesa: Restricted — corridor route required, .*clearance: not requested/);
  assert.match(t, /Listed area T4: .* premium 901 cr/);
  assert.match(t, /Corridor: Ukrainian Black Sea corridor .* required to enter Odesa/);
  assert.match(t, /Your captains: Your risk policy is 'avoid'/);
  assert.match(t, /Blockers: none/);
  assert.match(html, /data-pol="go"(?![^>]*disabled)/);
  assert.match(html, /data-pol="cover" data-areas="jwc-blacksea-ua"/);
  assert.match(html, /data-pol="planAround"(?![^>]*disabled)/);
  neutral(html, 'risk odesa');
  const job = { id: 'x', type: 'freight', from: 'istanbul', to: 'novorossiysk', good: 'machinery', qty: 300 };
  const rb = riskCheck(ds, ctx, { route: { from: { lat: ist.lat, lon: ist.lon }, points: [[44.73, 37.79]] }, speedKn: 11.9, cls: 'coaster', cond: 78, toHarbor: 'novorossiysk', job, vessel: v });
  const hb = V.riskCheckHTML(rb, { ds, nowS: T0, contract: true });
  assert.ok(rb.blockers.length > 0);
  assert.match(hb, /data-pol="go"[^>]*disabled/);
  assert.ok(text(hb).indexOf('Blocker:') < text(hb).indexOf('Destination'), 'blockers first');
  const calm = riskCheck(ds, ctx, { route: { from: H('rotterdam'), points: [[51.94, 1.33]] }, speedKn: 11.9, cls: 'coaster', cond: 78, toHarbor: 'felixstowe', vessel: v });
  assert.match(V.riskCheckHTML(calm, { ds, nowS: T0 }), /data-pol="planAround"[^>]*disabled/);
});

test('Compliance panel, move-home card and re-flag picker from the engine views', () => {
  const view = pol.officeView(A);
  const html = V.complianceHTML(view, { ds, nowS: T0, ctx: ctxOf(A), home: { id: 'rotterdam', name: 'Rotterdam', cc: 'NL' }, docked: { id: 'istanbul', name: 'Istanbul' } });
  const t = text(html);
  for (const k of ['Jurisdiction', 'Measures that apply to you', 'Fleet flags', 'Risk policy', 'Standing with port authorities', 'Records', 'Dataset']) assert.ok(t.includes(k), k);
  assert.match(t, /Measures followed EU, UN/);
  assert.match(t, /EU · Council Regulation \(EU\) No 833\/2014/);
  assert.match(html, /data-pol="homePlan" data-harbor="istanbul"/);
  assert.match(html, /class="polSegBtn on" data-pol="policy" data-policy="avoid"/);
  linksResolve(html, 'compliance');
  neutral(html, 'compliance');
  const hb = V.complianceHTML(pol.officeView(B), { ds, nowS: T0, ctx: ctxOf(B), home: { id: 'novorossiysk', name: 'Novorossiysk', cc: 'RU' } });
  assert.match(text(hb), /Ports that refuse your current ship: .*European Union ports refuse this ship/, 'symmetric view: bans that others apply to this company');

  const plan = pol.homeMovePlan(A, H('new_orleans'), { baseCost: 25000 });
  const mh = V.moveHomeHTML({ ...plan, homeBefore: 'NL' }, { ds, nowS: T0, toName: 'New Orleans', money: 500000 }), mt = text(mh);
  assert.match(mt, /Measures followed EU, UN → US, UN changes/);
  assert.match(mt, /Customs territory EU Customs Union → /);
  assert.match(mt, /Ships that must re-flag ▲ Sea Lark ?: .* → .* · 3,600 cr · 1 h/);
  assert.match(mt, /Contracts to finish first ✖ Freight 800 t grain Rotterdam → Havana/);
  assert.match(mh, /data-pol="homeStart"[^>]*disabled/);
  neutral(mh, 'move');
  const ok = pol.homeMovePlan(A, H('istanbul'), { baseCost: 25000 });
  assert.equal(ok.allowed === true, !/data-pol="homeStart"[^>]*disabled/.test(V.moveHomeHTML(ok, { ds, nowS: T0, money: 1e7 })));

  const opts = V.reflagOptions(ds, 'NL', { cls: 'coaster', built: 2020 }, T0);
  const server = pol.reflagOptions(A, pol.vesselOf(A), 'NL');
  assert.deepEqual(opts.map((o) => [o.id, o.ok, o.cost, o.hours]), server.map((o) => [o.id, o.ok, o.cost, o.hours]), 'client mirror = server options');
  const rf = V.reflagHTML({ id: 'pAv1', name: 'Sea Lark', flag: pol.vesselOf(A).flag }, opts, { ds, nowS: T0, homeCc: 'NL' });
  assert.match(rf, /data-pol="reflag" data-vid="pAv1" data-reg="lr"/);
  neutral(rf, 'reflag');
});

test('contract cards for the five new types: badges, notes, blocked state', () => {
  let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const jobs = [];
  for (let i = 0; i < 40 && !jobs.length; i++) jobs.push(...diplomaticJobs(ds, 'odesa', T0, rnd, { harbors: HARBORS }).filter((j) => j.type === 'corridor'));
  jobs.push({ id: 'a', type: 'aid', from: 'jeddah', to: 'port_sudan', good: 'grain', qty: 1200, pay: 31800, title: 'Humanitarian cargo: 1,200 t grain to Port Sudan', pol: { tier: 3, refundPremium: true } });
  jobs.push({ id: 's', type: 'state', from: 'istanbul', to: 'alexandria', good: 'steel', qty: 4000, pay: 377000, title: 'State charter: 4,000 t steel coils to Alexandria', pol: { needs: { rep: { cc: 'TR', min: 20 } } } });
  jobs.push({ id: 'v', type: 'avoid', from: 'piraeus', to: 'singapore', good: 'steel', qty: 3600, pay: 3e6, title: 'Freight 3,600 t steel coils to Singapore', pol: { mustAvoid: ['jwc-redsea-aden'], tier: 0 } });
  jobs.push({ id: 'e', type: 'evac', from: 'beirut', to: 'piraeus', pax: 220, pay: 286000, title: 'Assisted departure: 220 passengers', pol: { tier: 2 } });
  const ctx = ctxOf(A);
  for (const j of jobs) {
    const check = jobCheck(ds, ctx, j, { cls: 'coaster', cond: 78 });
    const html = V.contractCardHTML(j, { ds, check, rep: ctx.rep }), t = text(html);
    assert.ok(t.includes(F.DIPLO_TYPES[j.type].label), j.type);
    neutral(html, j.type);
    if (j.type === 'corridor') { assert.match(t, /War risk T4 · \+200 %/); assert.match(t, /Premium refunded/); }
    if (j.type === 'avoid') assert.match(t, /Avoid Southern Red Sea/);
    if (j.type === 'state') { assert.equal(check.ok, false); assert.match(html, /data-act="accept"[^>]*disabled/); assert.match(t, /Not for your company — needs standing 20/); }
  }
});

test('chart overlay: tier fills, dashed ECA, corridor arrowheads, label hits, point hit-testing, popover, legend', () => {
  const W = 1200, Hh = 800, zoom = 5, TILE = 256, D2R = Math.PI / 180;
  const mx = (lon) => (lon + 180) / 360, my = (lat) => { const s = Math.sin(lat * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  const center = { lat: 44, lon: 32 }, S = TILE * 2 ** zoom;
  const chart = { W, H: Hh, zoom, scale: S,
    project: (lat, lon) => { let dx = mx(lon) - mx(center.lon); dx -= Math.round(dx); return { x: dx * S + W / 2, y: (my(lat) - my(center.lat)) * S + Hh / 2 }; },
    unproject: (x, y) => { const yy = my(center.lat) + (y - Hh / 2) / S; return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) / D2R, lon: (mx(center.lon) + (x - W / 2) / S) * 360 - 180 }; } };
  const log = { fills: [], dashes: [], tris: 0, texts: [] };
  const g = new Proxy({}, { get: (o, k) => (k in o ? o[k] : k === 'measureText' ? (s) => ({ width: s.length * 6 }) : k === 'fillText' ? (s) => log.texts.push(s) : k === 'closePath' ? () => { log.tris++; } : k === 'setLineDash' ? (d) => log.dashes.push(d.join(',')) : () => {}),
    set: (o, k, v) => { o[k] = v; if (k === 'fillStyle' && typeof v === 'string') log.fills.push(v); return true; } });
  const layers = { warrisk: true, corridors: true, eca: true, piracy: true, warnings: true };
  const hits = C.drawAreas(chart, g, ds, layers, { nowS: T0 });
  assert.ok(log.fills.includes(F.tierColour(4).fill) && log.fills.includes(F.tierColour(3).fill), 'tier 3 and 4 fills');
  assert.ok(log.texts.includes('Listed area · T4') && log.texts.includes('Corridor'));
  assert.ok(log.dashes.includes(F.AREA_STYLE.eca.dash.join(',')), 'ECA dashed');
  assert.ok(hits.some((h) => h.id === 'jwc-blacksea-ua') && hits.some((h) => h.id === 'ua-corridor'));
  const off = C.drawAreas(chart, g, ds, { warrisk: false, corridors: false, eca: false, piracy: false, warnings: false }, { nowS: T0 });
  assert.deepEqual(off, [], 'toggled off: nothing drawn');
  const p = chart.project(45.6, 31.2);   // inside the Ukrainian ports sector
  const under = C.areasUnder(chart, ds, layers, p.x, p.y, { nowS: T0 });
  assert.equal(under[0].id, 'jwc-blacksea-ua');
  const corrPt = chart.project(43, 28);
  assert.ok(C.areasUnder(chart, ds, layers, corrPt.x + 3, corrPt.y, { nowS: T0 }).some((a) => a.id === 'ua-corridor'), 'corridor within 12 px');
  const pop = C.popoverHTML(under, { ds, nowS: T0, cls: 'coaster', cond: 78 });
  assert.match(text(pop), /For your ship 901 cr per call \/ transit/);
  neutral(pop, 'popover');
  const leg = C.legendHTML({ warrisk: true, corridors: true, eca: false, piracy: false, warnings: false });
  assert.equal((leg.match(/aria-pressed="true"/g) || []).length, 2);
  assert.ok(C.shown(ds.areaById['eca-canarctic'], T0), 'future ECA is drawn (faint, "from …")');
  assert.equal(C.drawAreas(chart, g, null, layers).length, 0);
});

test('client preview = server payload: harbourRules on the client ctx matches the engine for status and blocks', () => {
  for (const id of ['odesa', 'ust_luga', 'rotterdam', 'jeddah']) {
    const srv = pol.harbourPayload(A, H(id)), cli = harbourRules(ds, ctxOf(A), id, { cls: 'coaster', cond: 78 });
    assert.deepEqual(cli.status, srv.status, id);
    assert.deepEqual(cli.you.blocked.map((b) => b.good), srv.you.blocked.map((b) => b.good), id);
    assert.deepEqual(cli.security.map((s) => s.premium), srv.security.map((s) => s.premium), id);
  }
});

test('PoliticsUi (public/js/politics.js) works headless: dataset parts, messages, previews, actions to the server', async () => {
  const { PoliticsUi, PARTS } = await import('../public/js/politics.js');
  const { readParts } = await import('../server/politics.js');
  const sent = [];
  const you = { name: 'Carla', money: 500000, home: 'rotterdam', homeName: 'Rotterdam (Maasvlakte)', docked: 'istanbul', cond: 78, ship: { cls: 'coaster' }, cargo: [], pol: pol.youView(A) };
  const app = { simTime: T0, world: { harbors: HARBORS }, you, net: { action: (a, f) => sent.push([a, f]) } };
  const parts = readParts();
  const ui = new PoliticsUi(app, { fetch: async (url) => (url === '/api/politics' ? { ok: false, status: 404 } : { ok: true, json: async () => parts[url.match(/politics\/(\w+)\.json/)[1]] }) });
  assert.ok(await ui.load(), 'falls back to /shared/politics/*.json');
  assert.deepEqual(Object.keys(ui.parts), PARTS);
  ui.onYou(you);
  ui.onFleet({ compliance: pol.officeView(A) });
  const odesa = { ...H('odesa') };
  assert.equal(ui.rulesOf(odesa).preview, true, 'without harbor.rules: a client preview');
  ui.onHarbor({ ...odesa, rules: pol.harbourPayload(A, H('odesa')) });
  assert.equal(ui.rulesOf(odesa).preview, false);
  assert.deepEqual(ui.quickTile(odesa).slice(0, 3), ['rules', 'flag', 'Rules']);
  assert.match(ui.rulesTabHTML(odesa, you), /Restricted — corridor route required/);
  assert.match(ui.badgesFor({ id: 'j', type: 'freight', from: 'istanbul', to: 'novorossiysk', good: 'machinery', qty: 10, pol: { tier: 3 } }), /Not for your company — /);
  assert.match(ui.complianceTabHTML(), /Compliance/);
  assert.equal(ui.onMessage({ t: 'pol_home_plan', plan: pol.homeMovePlan(A, H('istanbul')) }), true);
  ui.act('policy', { dataset: { policy: 'accept' } });
  ui.act('clearance', { dataset: { harbor: 'odesa' } });
  ui.act('reflag', { dataset: { vid: 'pAv1', reg: 'lr' } });
  assert.deepEqual(sent, [['pol_policy', { riskPolicy: 'accept' }], ['pol_clearance', { harbor: 'odesa' }], ['pol_reflag', { vesselId: 'pAv1', registry: 'lr' }]]);
  assert.equal(ui.compliance.riskPolicy, 'accept', 'optimistic update until the next fleet message');
});
