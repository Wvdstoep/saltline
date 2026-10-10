// World economy, Lane D: HTML builders (request card snapshot desktop and 390 px, goods rows, chips;
// docs/WORLD-ECONOMY-CONTRACT.md §14.1, §14.3, §17 econui).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../public/js/econfmt.js';

const REQ = { id: 'q1a2b', harbor: 'rotterdam', harborName: 'Rotterdam', good: 'coffee', qty: 2400, done: 600, pledged: 480, open: 1320, unit: 4508, premium: 0.27, leftH: 436, maker: { id: 'santos', name: 'Santos', km: 12408 }, mine: null };

test('request card (desktop): icon, name, "2,400 t (200 TEU)", progress (done, pledged, open), locked price, +27 %, "18 d 4 h", nearest maker, hold fit, buttons', () => {
  const html = F.requestCardHTML(REQ, { harborName: 'Rotterdam', docked: true, eligibleT: 720, fit: { ok: true }, shipName: 'Container feeder' });
  const expected = `<article class="ecReq" data-req="q1a2b">
  <header><span class="ecReqIcon" data-cat="box"></span><div><b>Green coffee</b><small>Rotterdam requests 2,400 t (200 TEU)</small></div><span class="ecPrem">+27 %</span></header>
  <div class="ecProg" role="img" aria-label="600 t delivered, 480 t pledged, 1,320 t open"><i class="d" style="width:25.0%"></i><i class="p" style="width:20.0%"></i></div>
  <div class="ecReqNums"><span>600 t delivered · 480 t pledged · <b>1,320 t open</b></span></div>
  <div class="ecReqNums"><span><b>4,508</b> cr/t locked (≈ 54,096 cr/TEU)</span><span class="ecDue">18 d 4 h left</span></div>
  <div class="ecReqNums"><span>from Santos, 6,700 nm</span></div>
  <div class="ecReqFit"><span class="ecFit ok">Your Container feeder can carry it ✓</span></div>
  <div class="ecReqBtns"><button class="primary" data-act="econ-deliver" data-req="q1a2b">Deliver 720 t</button><button data-act="econ-pledge" data-req="q1a2b" data-open="1320" >Pledge…</button><button data-act="econ-plan" data-good="coffee">Plan route</button></div>
</article>`;
  assert.equal(html, expected);
});

test('request card (390 px phone): the carousel class, no Deliver when not docked or nothing eligible, the handling chip and my pledge', () => {
  const html = F.requestCardHTML({ ...REQ, mine: { qty: 480, until: 0 } }, { phone: true, docked: false, eligibleT: 0, fit: { ok: false, text: 'Needs container cells — e.g. Feeder, Panamax, Neo-Panamax' } });
  assert.match(html, /^<article class="ecReq phone" data-req="q1a2b">/);
  assert.ok(!/econ-deliver/.test(html));
  assert.match(html, /<span class="ecFit no">Needs container cells — e\.g\. Feeder, Panamax, Neo-Panamax<\/span>/);
  assert.match(html, /<span class="ecMine">You pledged 480 t<\/span>/);
  const none = F.requestCardHTML({ ...REQ, open: 0 }, {});
  assert.match(none, /data-open="0" disabled>Pledge…/);
});

test('goods rows: buy only where buyable ("Not sold here — imported"), unit line, sparkline size per layout, Max = min(hold fit, buyable, cash)', () => {
  const row = { id: 'coffee', role: 'I', buy: 3550, sell: 3400, buyable: 0, stock: 1456, n: 2800, sEq: 1456, trend: -1, d24: -2.1, why: { code: 'short', text: 'Short' }, hist7: [3600, 3580, 3550] };
  const d = F.goodRowHTML(row, { have: 0, fit: { ok: true }, money: 1e6, freeT: 4000 });
  assert.match(d, /Not sold here — imported/); assert.match(d, /data-act="econ-buy" data-good="coffee" disabled/); assert.match(d, /data-act="econ-sell" data-good="coffee" disabled/);
  assert.match(d, /≈ 40,800 cr\/TEU/); assert.match(d, /viewBox="0 0 72 20"/); assert.match(d, /<span class="ecWhy ecWhy-short">Short<\/span>/); assert.match(d, /−2\.1 %/);
  const p = F.goodRowHTML({ ...row, id: 'flowers', role: 'P', buyable: 900, buy: 2000 }, { have: 12, fit: { ok: true }, money: 100000, freeT: 4000, phone: true });
  assert.match(p, /viewBox="0 0 56 16"/); assert.match(p, /Made here/); assert.match(p, /12 t aboard/);
  assert.match(p, /data-act="econ-max" data-good="flowers" data-v="49"/, 'cash limits Max: 100,000 / (2,000 × 1.02)');
  const t = F.goodRowHTML({ ...row, id: 'bananas', role: 'P', buyable: 500, buy: 900 }, { fit: { ok: false, text: 'Needs refrigerated holds — e.g. Reefer ship' }, money: 1e9, freeT: 1e9 });
  assert.match(t, /<span class="ecFit no" title="Needs refrigerated holds — e\.g\. Reefer ship">/); assert.match(t, /data-act="econ-buy" data-good="bananas" disabled title="Needs refrigerated holds/);
});

test('Made here / Needed here chips: tier classes, filter action, site note', () => {
  const h = F.chipRow('Made here', [{ good: 'flowers', tier: 1 }, { good: 'pharma', tier: 3 }], 'make');
  assert.equal(h, '<div class="ecChips ecChips-make"><span class="ecChipsHead">Made here</span><div class="ecChipScroll"><button type="button" class="ecChip t1" data-act="econ-filter" data-good="flowers" title="Cut flowers">Cut flowers</button><button type="button" class="ecChip t3" data-act="econ-filter" data-good="pharma" title="Medicines">Medicines</button></div></div>');
  assert.match(F.chipRow('Needed here', [{ good: 'ore', tier: 2, site: 'steel' }], 'need'), /title="Iron ore — for the local plant"/);
  assert.equal(F.chipRow('x', [], 'make'), '');
});
