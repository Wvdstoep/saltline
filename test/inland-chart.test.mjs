// Inland harbours on the chart (public/js/mhchart.js, pure parts) and the card text (§7.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symbolSpec, bboxKey, visibleRows, cardLines, cardHTML, MHChartLayer, esc } from '../public/js/mhchart.js';
import { harbourCard } from '../shared/mharbour.js';

test('symbols, bbox and visibility (zoom ≥ 11; sub-harbours from zoom 12)', () => {
  assert.deepEqual(symbolSpec('marina'), { shape: 'circle', color: '#c2187a', glyph: 'yacht', r: 7, dashed: false });
  assert.deepEqual(symbolSpec('passant', { est: true }), { shape: 'square', color: '#1f5fbf', glyph: 'P', r: 7, dashed: true });
  assert.equal(symbolSpec('anchor').glyph, 'anchor');
  assert.equal(symbolSpec('fish').glyph, 'fish');
  assert.equal(bboxKey({ lat: 51.95, lon: 4.1 }, { lat: 51.9, lon: 4.2 }, 10), null);
  assert.deepEqual(bboxKey({ lat: 51.9512, lon: 4.1033 }, { lat: 51.9001, lon: 4.2099 }, 11.5), { key: '51.9,4.1,51.96,4.21', s: 51.9, w: 4.1, n: 51.96, e: 4.21 });
  const rows = [{ id: 'a', sub: null }, { id: 'b', sub: 'rotterdam' }];
  assert.deepEqual(visibleRows(rows, 10), []);
  assert.deepEqual(visibleRows(rows, 11).map((r) => r.id), ['a']);
  assert.deepEqual(visibleRows(rows, 12).map((r) => r.id), ['a', 'b']);
  assert.equal(esc('<a&"b">'), '&lt;a&amp;&quot;b&quot;&gt;');
});

test('card lines and HTML from a card', () => {
  const h = { id: 'mh:test:1', name: 'Jachthaven <Test>', tier: 'marina', lat: 52, lon: 5, cc: 'NL', e: 1, places: 120, pont: [[52.0, 5.0, 52.0, 5.0014764, 100]], svc: { fuel: true, boatyard: true }, sub: { id: 'rotterdam', name: 'Rotterdam', dKm: 4 } };
  const c = harbourCard(h, { ship: { L: 11, B: 3.6, T: 1.9, disp: 6, yacht: true }, reach: { state: 'yes', text: 'Yes' } });
  assert.deepEqual(cardLines(c), [
    'Jachthaven <Test> · Marina (Jachthaven)', 'Harbour master ch 31 (simulated)', 'Depth 2 m (est.)', '44 of 44 berths take you',
    '21 cr per night (1.6 cr per metre + 3 cr power)', 'Reachable: Yes', 'Inside the port of Rotterdam (4 km): its market, shipyard and boards are at the harbour sheet.',
  ]);
  const html = cardHTML({ ...c, namedSheet: '/api/harbor/rotterdam' });
  assert.ok(html.includes('<h3>Jachthaven &lt;Test&gt;</h3>'));
  assert.ok(html.includes('44 berths (44 × 15 m)'));
  assert.ok(html.includes('<span class="chip">Fuel</span>') && html.includes('Repairs ×1.3 (yachts)'));
  assert.ok(html.includes('data-tune="31"') && html.includes('data-named="rotterdam"'));
  assert.equal(cardHTML(null), '<div class="mh-card">Unknown harbour.</div>');
});

test('chart layer asks the server once per bbox and draws only what is on screen', async () => {
  const calls = [];
  const layer = new MHChartLayer({}, { fetchImpl: async (u) => { calls.push(u); return { harbours: [{ id: 'mh:1', name: 'A', tier: 'marina', lat: 51.92, lon: 4.15, vhf: 31, sym: 'marina', est: false, sub: null }] }; } });
  const ops = [];
  const g = new Proxy({}, { get: (_, k) => (k in _ ? _[k] : (...a) => ops.push([k, ...a])), set: (o, k, v) => { o[k] = v; return true; } });
  const chart = { W: 800, H: 600, zoom: 13, unproject: (x, y) => ({ lat: 51.95 - y * 0.0001, lon: 4.1 + x * 0.0001 }), project: (lat, lon) => ({ x: (lon - 4.1) / 0.0001, y: (51.95 - lat) / 0.0001 }), requestDraw: () => {} };
  layer.drawChartLayer(chart, g);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['/api/mh?bbox=51.89,4.1,51.95,4.18&z=13']);
  layer.drawChartLayer(chart, g);
  assert.equal(calls.length, 1);                             // same bbox: cached
  assert.ok(ops.some((o) => o[0] === 'fillText' && o[1] === 'A · ch 31'));
  const hits = []; layer.chartHits((lat, lon, o) => hits.push(o.text));
  assert.deepEqual(hits, ['A · Marina · ch 31']);
});
