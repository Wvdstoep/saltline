// World economy, Lane D: pure formatting (public/js/econfmt.js; docs/WORLD-ECONOMY-CONTRACT.md §14, §17 econui).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../public/js/econfmt.js';

test('unit prices: cr/TEU = cr/t × 12, cr/m³, cr/CEU, cr/head; tonnes show nothing extra', () => {
  assert.equal(F.perUnitText(2345, 'coffee'), '≈ 28,140 cr/TEU');
  assert.equal(F.perUnitText(570, 'lng'), '≈ 257 cr/m³');
  assert.equal(F.perUnitText(4472, 'vehicles'), '≈ 6,708 cr/CEU');
  assert.equal(F.perUnitText(1643, 'livestock'), '≈ 822 cr/head');
  assert.equal(F.perUnitText(260, 'grain'), '');
  assert.equal(F.qtyText(2400, 'coffee'), '2,400 t (200 TEU)');
  assert.equal(F.qtyText(1200, 'ore'), '1,200 t');
  assert.deepEqual(F.unitOf('lpg'), { unit: 'm3', word: 'm³', tPer: 0.55 });
});

test('deadline text: "18 d 4 h", hours and minutes, due', () => {
  assert.equal(F.deadlineText(18 * 24 + 4), '18 d 4 h');
  assert.equal(F.deadlineText(5 + 1 / 3), '5 h 20 min');
  assert.equal(F.deadlineText(3), '3 h');
  assert.equal(F.deadlineText(0.66), '40 min');
  assert.equal(F.deadlineText(0), 'due');
  assert.equal(F.deadlineText(-3), 'due');
});

test('role badges, reason chips, 24 h change, premium (plain words, E8)', () => {
  assert.equal(F.roleBadge('P'), '<span class="ecRole ecRoleP">Made here</span>');
  assert.equal(F.roleBadge('L'), '<span class="ecRole ecRoleL">Traded</span>');
  assert.equal(F.roleBadge('I'), '<span class="ecRole ecRoleI">Needed</span>');
  assert.equal(F.roleBadge(null), '');
  assert.equal(F.reasonChip({ code: 'harvest', text: 'Harvest in' }), '<span class="ecWhy ecWhy-harvest">Harvest in</span>');
  assert.equal(F.reasonChip(null), '');
  assert.equal(F.reasonChip({ code: 'x', text: '<b>' }), '<span class="ecWhy ecWhy-x">&lt;b&gt;</span>');
  assert.equal(F.d24Text(3.25), '+3.3 %'); assert.equal(F.d24Text(-1.04), '−1.0 %'); assert.equal(F.d24Text(0), '±0.0 %'); assert.equal(F.d24Text(null), '—');
  assert.equal(F.premiumText(0.2667), '+27 %');
  assert.equal(F.goodName('coffee'), 'Green coffee'); assert.equal(F.catOf('salmon'), 'reefer'); assert.equal(F.catName('ores'), 'Ores, minerals, coal');
});

test('sparkline: 72 × 20 (desktop), 56 × 16 (phone), gaps stay gaps, last point marked; empty history is a dashed line', () => {
  const s = F.sparkSvg([1, 2, null, 4, 5], { trend: 1 });
  assert.match(s, /^<svg class="ecSpark up" viewBox="0 0 72 20" width="72" height="20"/);
  assert.equal((s.match(/<polyline/g) || []).length, 2);
  assert.match(s, /<circle cx="69\.0" cy="2\.0" r="2\.2"\/>/);
  assert.match(F.sparkSvg([3, 3, 3], { w: 56, h: 16 }), /viewBox="0 0 56 16"/);
  assert.match(F.sparkSvg([]), /ecSparkNone/); assert.match(F.sparkSvg([7]), /no history yet/);
});

test('stock bar: stock against normal (0 … 2 n), the normal mark in the middle, the equilibrium marker', () => {
  assert.equal(F.stockBar(500, 1000, 520), '<span class="ecStock short" title="Stock 500 t · normal 1,000 t · settles near 520 t"><i style="width:25%"></i><b class="ecNorm" style="left:50%"></b><b class="ecEq" style="left:26%"></b></span>');
  assert.match(F.stockBar(1800, 1000, 1800), /ecStock glut/);
  assert.match(F.stockBar(1000, 1000, null), /ecStock ok/);
  assert.match(F.stockBar(5000, 1000, null), /width:100%/);
});

test('season strip: 12 months, bump months shaded, the current month outlined; 30-day chart', () => {
  const f = Array.from({ length: 12 }, (_, m) => (m === 7 ? 2.4 : m === 1 ? 0.6 : 1));
  const s = F.seasonStrip(f, 9);
  assert.equal((s.match(/<span/g) || []).length, 12);
  assert.match(s, /<span class="hi" title="Aug: ×2\.40">A<\/span>/); assert.match(s, /<span class="lo" title="Feb: ×0\.60">F<\/span>/); assert.match(s, /class=" now" title="Oct/);
  assert.match(F.chartSvg([1, 2, 3]), /<polyline points="30\.0,80\.0 173\.0,43\.0 316\.0,6\.0"\/>/);
  assert.match(F.chartSvg([5]), /Not enough history yet/);
});
