// World politics, client lane: pure formatters (public/js/politicsfmt.js), contract §7 politics-client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../public/js/politicsfmt.js';
import { TEMPLATES, fill, fmtDate as sharedFmtDate, ecaCost, riskPay, POL } from '../shared/politics.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { bannedHits } from '../scripts/politics/validate.mjs';

const T = Date.UTC(2026, 9, 9, 12, 0, 0) / 1000;   // Fri 09 Oct 2026 12:00 UTC

test('fmtSrc: "{publisher} · {date}", short name first, asOf overrides', () => {
  assert.equal(F.fmtSrc({ publisher: 'JWC', published: '2026-10-01' }), 'JWC · 01 Oct 2026');
  assert.equal(F.fmtSrc({ short: 'JWC JWLA-034', publisher: 'Joint War Committee', published: '2026-07-29' }), 'JWC JWLA-034 · 29 Jul 2026');
  assert.equal(F.fmtSrc({ publisher: 'OFAC', published: '2025-01-15' }, '2026-10-09'), 'OFAC · 09 Oct 2026');
  assert.equal(F.fmtSrc(null), 'source');
  assert.equal(F.fmtDate('2026-10-01'), sharedFmtDate('2026-10-01'));
  assert.equal(F.fmtDate(''), '');
});

test('stale tag after reviewBy, never before or without one (P8)', () => {
  assert.equal(F.isStaleRec({ reviewBy: '2026-10-08' }, T), true);
  assert.equal(F.isStaleRec({ reviewBy: '2026-10-09' }, T), false);
  assert.equal(F.isStaleRec({}, T), false);
  assert.equal(F.staleText({ reviewBy: '2026-09-30' }, T), 'may be out of date');
  assert.equal(F.staleText({ stale: true }, T), 'may be out of date');
  assert.equal(F.staleText({ reviewBy: '2026-11-08' }, T), '');
});

test('status chips: classes, marks and the §2.1 template texts', () => {
  const o = F.statusChip({ value: 'open' });
  assert.deepEqual([o.cls, o.tone, o.mark, o.text], ['polSt-open', 'good', '●', 'Open']);
  const r = F.statusChip({ value: 'restricted', reasons: ['corridor route required', 'martial law in force'] });
  assert.deepEqual([r.cls, r.tone, r.mark, r.short], ['polSt-restricted', 'warn', '▲', 'Restricted']);
  assert.equal(r.text, fill(TEMPLATES.statusRestricted, { reason: 'corridor route required, martial law in force' }));
  const c = F.statusChip({ value: 'closed', reasons: ['port operations suspended'] });
  assert.equal(c.text, fill(TEMPLATES.statusClosed, { reason: 'port operations suspended' }));
  assert.deepEqual([c.cls, c.tone, c.mark], ['polSt-closed', 'bad', '✖']);
  assert.equal(F.statusChip(null).value, 'open');
});

test('tier colours: red-orange, alpha 0.08 / 0.12 / 0.16 / 0.20 by tier', () => {
  assert.deepEqual([1, 2, 3, 4].map((t) => F.tierColour(t).alpha), [0.08, 0.12, 0.16, 0.20]);
  assert.equal(F.tierColour(3).fill, 'rgba(255,96,64,0.16)');
  assert.equal(F.tierColour(9).tier, 1);
  assert.equal(F.areaLabel({ kind: 'war_risk', tier: 3 }), 'Listed area · T3');
  assert.equal(F.areaLabel({ kind: 'eca' }), 'ECA');
  assert.equal(F.areaLabel({ kind: 'piracy' }), 'Piracy HRA');
  assert.deepEqual(F.CHART_LAYERS.filter((l) => l.on).map((l) => l.id), ['warrisk', 'corridors']);   // §5.2 defaults
  assert.equal(F.layerOfKind('warning'), 'warnings');
});

test('percentages, hours, km, credits', () => {
  assert.equal(F.fmtPct(0.012), '1.2 %');
  assert.equal(F.fmtPct(0.0005), '0.05 %');
  assert.equal(F.fmtPct(0.003), '0.3 %');
  assert.equal(F.fmtPct(0.12), '12 %');
  assert.equal(F.fmtPct(0.00004), '< 0.01 %');
  assert.equal(F.fmtPct(1.0, { pct: true }), '1 %');
  assert.equal(F.fmtPct(7.5, { pct: true }), '7.5 %');
  assert.equal(F.fmtPct(0), '0 %');
  assert.equal(F.fmtHours(0.4), '24 min');
  assert.equal(F.fmtHours(13.2), '13 h');
  assert.equal(F.fmtHours(50), '2 d 2 h');
  assert.equal(F.fmtKm(412.4), '412 km');
  assert.equal(F.fmtKm(37.25), '37.3 km');
  assert.equal(F.fmtCr(5653), '5,653 cr');
  assert.equal(F.fmtWhen(T + 3600, T), '13:00 UTC');
  assert.equal(F.fmtWhen(T + 86400, T), '10 Oct 12:00 UTC');
});

test('standing: effects, tones, centred bars, top/bottom lists', () => {
  assert.deepEqual(F.repEffects(24), ['state charters']);
  assert.deepEqual(F.repEffects(41), ['trusted operator · customs fee waived']);
  assert.deepEqual(F.repEffects(-34), ['watched · more inspections']);
  assert.deepEqual(F.repEffects(-60), ['refused entry']);
  assert.deepEqual(F.repEffects(5), []);
  assert.equal(F.REP_LEVELS.charterMin, POL.REP.charterMin);
  assert.equal(F.REP_LEVELS.trusted, POL.REP.trusted);
  assert.equal(F.REP_LEVELS.banned, POL.REP.banned);
  assert.deepEqual(F.repBar(50), { left: 50, width: 25 });
  assert.deepEqual(F.repBar(-40), { left: 30, width: 20 });
  assert.deepEqual(F.repBar(500), { left: 50, width: 50 });
  const { top, bottom } = F.repTopBottom({ NL: 24, DE: 41, RU: -8, EG: -34, TR: 0 }, 8);
  assert.deepEqual(top.map((x) => x[0]), ['DE', 'NL']);
  assert.deepEqual(bottom.map((x) => x[0]), ['RU', 'EG']);
});

test('quick tile: "{status} · {psc}{ · ECA}{ · War risk x %}" and its tone', () => {
  const odesa = { status: { value: 'restricted', reasons: ['corridor route required'] }, psc: { name: 'Black Sea MoU' }, eca: [], security: [{ apPct: 1 }] };
  assert.deepEqual(F.quickTile(odesa), { tab: 'rules', title: 'Rules', sub: 'Restricted · Black Sea MoU · War risk 1 %', tone: 'warn' });
  const rdam = { status: { value: 'open' }, psc: { name: 'Paris MoU' }, eca: [{ inForce: true }], security: [] };
  assert.deepEqual(F.quickTile(rdam), { tab: 'rules', title: 'Rules', sub: 'Open · Paris MoU · ECA', tone: '' });
  assert.equal(F.quickTile({ status: { value: 'closed', reasons: ['port operations suspended'] } }).tone, 'bad');
});

test('contract badges: blocked, war tier with RISK_PAY, corridor, refund, cabotage, avoid, standing', () => {
  for (const t of [1, 2, 3, 4]) assert.equal(Math.round((F.RISK_PAY[t]) * 100), Math.round((riskPay(100000, t) - 100000) / 1000));
  const corridor = F.jobBadges({ type: 'corridor', pol: { tier: 4, refundPremium: true } }, { ok: true, warn: [], tags: {} });
  assert.deepEqual(corridor.map((b) => b.text), ['War risk T4 · +200 %', 'Corridor', 'Premium refunded']);
  const blocked = F.jobBadges({ type: 'freight', pol: { cab: 'US' } }, { ok: false, block: { code: 'sanction', measureText: 'Council Regulation (EU) No 833/2014, Art. 3k', text: 'Not allowed for your company: Council Regulation (EU) No 833/2014, Art. 3k (EUR-Lex, 09 Oct 2026).' }, warn: [], tags: { cab: 'US' } });
  assert.equal(blocked[0].text, 'Not for your company — Council Regulation (EU) No 833/2014, Art. 3k');
  assert.equal(blocked[0].cls, 'bad');
  assert.ok(blocked.some((b) => b.text === 'Cabotage: US only'));
  const avoid = F.jobBadges({ type: 'avoid', pol: { mustAvoid: ['jwc-redsea-aden'] } }, null, (id) => (id === 'jwc-redsea-aden' ? 'Southern Red Sea' : id));
  assert.deepEqual(avoid.map((b) => b.text), ['Avoid Southern Red Sea']);
  const state = F.jobBadges({ type: 'state', pol: { needs: { rep: { cc: 'TR', min: 20 } } } });
  assert.deepEqual(state.map((b) => b.text), ['Standing ≥ 20 with TR']);
  assert.equal(F.reasonShort({ text: 'Rotterdam port control refuses entry: Council Regulation (EU) No 833/2014, Art. 3ea (EUR-Lex).' }), 'Council Regulation (EU) No 833/2014, Art. 3ea');
});

test('risk rows: blockers first, destination with clearance, premium, ECA cost, piracy, PSC, captains', () => {
  const report = {
    blockers: [{ text: 'Not allowed for your company: Act A, Art. 1 (X, 01 Oct 2026).' }],
    dest: { harbor: 'odesa', status: { value: 'restricted', reasons: ['corridor route required'] }, entry: { ok: false, needs: 'clearance', refuse: { code: 'clearance' } }, pCall: 0.015, psc: { regime: 'blacksea', profile: 'SRS', pInspect: 0.12, pDetain: 0.06 } },
    lines: [{ kind: 'war_risk', id: 'a', name: 'Black Sea (UA)', tier: 4, km: 412, h: 13, premium: 901, pSea: 0.003 }, { kind: 'eca', id: 'e', name: 'North Sea ECA', km: 50, inForce: true }, { kind: 'piracy', id: 'p', name: 'Gulf of Guinea', km: 600, p: 0.0238 }],
  };
  const rows = F.riskRows(report, { toName: 'Odesa', refunded: true, ecaCostCr: 455, pscName: 'Black Sea MoU' });
  assert.equal(rows[0].tone, 'block');
  assert.equal(rows[1].text, 'Restricted — corridor route required, clearance: not requested');
  assert.equal(rows[1].action, 'clearance');
  assert.equal(rows[2].text, 'Black Sea (UA) · 412 km · 13 h · premium 901 cr (refunded by shipper) · incident ≈ 0.3 % at sea + 1.5 % in port');
  assert.ok(rows.some((r) => r.label === 'ECA' && r.text === 'North Sea ECA 50 km · fuel switch ≈ 455 cr'));
  assert.ok(rows.some((r) => r.label === 'Piracy' && r.text === 'Gulf of Guinea · 600 km · incident ≈ 2.4 %'));
  assert.ok(rows.some((r) => r.text === 'Black Sea MoU · your profile SRS · inspection 12 % · detention if inspected 6 %'));
  assert.ok(!rows.some((r) => r.label === 'Blockers'));
  const clear = F.riskRows({ blockers: [], lines: [], dest: null });
  assert.deepEqual(clear.map((r) => r.text), ['none on this route', 'normal pay (no IBF warlike area)', 'none on this route', 'none', 'none']);
});

test('ECA fuel estimate: burnPerHour follows the physics fuel curve; 2.0 t → 455 cr (§4.8)', () => {
  assert.equal(ecaCost(2.0), 455);
  const C = SHIP_CLASSES.coaster;
  assert.equal(Math.round(F.burnPerHour(C, C.maxKn, 100) * 1000) / 1000, C.burn);
  assert.equal(Math.round(F.burnPerHour(C, 0, 100) * 1000) / 1000, Math.round(C.burn * 0.1 * 1000) / 1000);
});

test('move rows and cost lines from a homeMovePlan', () => {
  const plan = { allowed: true, country: 'US', homeBefore: 'NL', followsBefore: ['EU', 'UN'], followsAfter: ['US', 'UN'], customsBefore: 'eu-cu', customsAfter: 'US', cabotage: { before: 'bloc', after: 'national' }, costParts: { move: 25000, formation: 5000, reflag: 3600 } };
  const rows = F.moveRows(plan, (cc) => ({ NL: 'Netherlands', US: 'United States' }[cc]));
  assert.deepEqual(rows.map((r) => [r.label, r.before, r.after, r.changed]), [
    ['Measures followed', 'EU, UN', 'US, UN', true], ['Customs territory', 'eu-cu', 'US', true], ['Coastal trade at home', 'bloc', 'national', true], ['Home country', 'Netherlands', 'United States', true]]);
  assert.deepEqual(F.moveCostLines(plan).map((c) => c.cr), [25000, 5000, 3600]);
  assert.deepEqual(F.moveRows(null), []);
});

test('every fixed client string is neutral (banned-words list of §2.1)', () => {
  const strings = [F.AMBER_STALE, F.GAME_RULE, ...F.POLICIES.flatMap((p) => [p.label, p.blurb]), ...Object.values(F.DIPLO_TYPES).flatMap((t) => [t.label, t.blurb]),
    ...Object.values(F.AREA_STYLE).flatMap((s) => [s.label, s.legend]), ...F.CHART_LAYERS.map((l) => l.label), ...['national', 'bloc', 'licence', 'open', 'nodata'].map((r) => F.cabotageText(r, { cc: 'US', bloc: 'EU' })),
    ...[-80, -40, 25, 45].flatMap((n) => F.repEffects(n)), F.PSC_PROFILE.LRS, F.PSC_PROFILE.SRS, F.PSC_PROFILE.HRS];
  for (const s of strings) assert.deepEqual(bannedHits(s), [], s);
});
