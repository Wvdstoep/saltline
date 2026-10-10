// World economy, Lane C: the split market API and the requests finder (docs/WORLD-ECONOMY-CONTRACT.md §9.4, §15, §17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { cachedSnapshot, econHandlers, findTrades, parseRoutesQuery } from '../server/market.js';
import { econPayload } from '../server/econdata.js';
import { MARKET_GOODS } from '../server/economy.js';
import { canLoad } from '../shared/cargo.js';
import { serviceKn, kmHours } from '../shared/rates.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-econ-api.json' }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
const res = () => ({ code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(t) { this.body = t; return this; }, set(k, v) { this.headers[k] = v; return this; }, type() { return this; }, end() { return this; } });
const req = (url, params = {}, headers = {}) => ({ headers, params, originalUrl: url, query: Object.fromEntries(new URL('http://x' + url).searchParams) });

test('/api/market keeps the legacy shape and the 7 legacy goods, with v: 2', () => {
  const g = mkGame(), s = cachedSnapshot(g, 0);
  assert.equal(s.v, 2);
  assert.deepEqual(s.goods.map((x) => x.id), MARKET_GOODS);
  assert.deepEqual(MARKET_GOODS, ['fish', 'grain', 'steel', 'machinery', 'containers', 'fuel', 'supplies']);
  assert.equal(s.harbors.length, HARBORS.length);
  const r = s.harbors.find((h) => h.id === 'rotterdam');
  assert.deepEqual(Object.keys(r.goods).sort(), [...MARKET_GOODS].sort());
  assert.deepEqual(Object.keys(r.goods.steel).sort(), ['buy', 'sell', 'stock', 'target', 'trend']);
});

test('/api/market/good/:good has one row per listing harbour; /api/market/harbor/:id has requests and make/need; 400 on unknown ids', () => {
  const g = mkGame(), h = econHandlers({ game: g, payload: econPayload, now: () => 0 });
  let r = res(); h.good(req('/api/market/good/coffee', { good: 'coffee' }), r);
  const listing = HARBORS.filter((x) => g.econ.row(x.id, 'coffee') >= 0).length;
  assert.equal(r.body.rows.length, listing); assert.ok(listing > 100);
  for (const row of r.body.rows) { assert.equal(row.length, 9); assert.ok(['P', 'L', 'I'].includes(row[1]) && row[2] >= row[3] && row[5] > 0); }
  const gz = zlib.gzipSync(JSON.stringify(r.body)).length;
  assert.ok(gz < 40 * 1024, `${gz} B gzip`);
  r = res(); h.good(req('/api/market/good/unobtainium', { good: 'unobtainium' }), r); assert.equal(r.code, 400);
  const st = g.harbors.rotterdam; st.stock.coffee = st.target.coffee * 0.3; g.econ.step(1 / 60, g.simTime);
  r = res(); h.harbor(req('/api/market/harbor/rotterdam', { id: 'rotterdam' }), r);
  const b = r.body;
  assert.equal(b.country, 'NL'); assert.equal(b.countryName, 'Netherlands');
  assert.ok(b.make.length && b.need.length && b.requests.some((q) => q.good === 'coffee'));
  for (const x of b.goods) for (const k of ['id', 'role', 'buy', 'sell', 'buyable', 'stock', 'n', 'sEq', 'trend', 'd24', 'why', 'hist7']) assert.ok(k in x, `${x.id}.${k}`);
  r = res(); h.harbor(req('/api/market/harbor/atlantis', { id: 'atlantis' }), r); assert.equal(r.code, 400);
  r = res(); h.requests(req('/api/market/requests?near=52,4&good=coffee&limit=5'), r);
  assert.ok(r.body.requests.length >= 1 && r.body.requests.length <= 5 && r.body.requests[0].harbor === 'rotterdam');
  for (let i = 1; i < r.body.requests.length; i++) assert.ok(r.body.requests[i].distKm >= r.body.requests[i - 1].distKm);
  r = res(); h.requests(req('/api/market/requests?good=nope'), r); assert.equal(r.code, 400);
});

test('/api/econ/data is the whole dataset with an ETag; a matching If-None-Match gets 304', () => {
  const g = mkGame(), h = econHandlers({ game: g, payload: econPayload });
  let r = res(); h.data(req('/api/econ/data'), r);
  const body = JSON.parse(r.body);
  assert.ok(body.v && body.catalogue.length === 80 && body.cats.length === 11 && body.countries.BR && body.seasons.length && Object.keys(body.chains).length === 13 && body.sites.sites.length && body.sources['igu-2025']);
  assert.ok(r.headers.ETag);
  const r2 = res(); h.data(req('/api/econ/data', {}, { 'if-none-match': r.headers.ETag }), r2); assert.equal(r2.code, 304);
  assert.ok(Buffer.byteLength(r.body) < 200 * 1024, `${Buffer.byteLength(r.body)} B`);
});

test('finder requests mode: rows only for hulls that can carry the good, within the deadline at service speed', () => {
  const g = mkGame();
  const st = g.harbors.rotterdam; st.stock.coffee = st.target.coffee * 0.3; g.econ.step(1 / 60, g.simTime);
  const p = parseRoutesQuery({ from: 'all', cls: 'feeder', mode: 'requests', good: 'coffee' });
  assert.ok(p.ok && p.q.mode === 'requests');
  assert.equal(parseRoutesQuery({ from: 'all', cls: 'boxship', mode: 'x' }).ok, false);
  const r = findTrades(g, null, p.q);
  assert.ok(r.trades.length >= 1, 'a feeder can fill a coffee request');
  for (const t of r.trades) {
    assert.equal(t.mode, 'request'); assert.ok(canLoad(t.good, 'feeder').ok);
    const q = g.econ.requests({ harbor: t.to }).find((x) => x.id === t.reqId);
    assert.ok(t.hours <= q.leftH + 1e-6 && t.marginH >= 0, `${t.hours} h of ${q.leftH}`);
    assert.ok(Math.abs(t.hours - kmHours(t.distKm, serviceKn('feeder', t.qty / 4000))) < 0.01);
    assert.equal(t.revenue, Math.round(q.unit * t.qty)); assert.ok(t.qty <= q.open);
    assert.ok(['P→I', 'L→I'].includes(t.role));
  }
  assert.equal(findTrades(g, null, { ...p.q, cls: 'tanker' }).trades.length, 0, 'a tanker cannot carry coffee');
});

test('finder trades mode: only goods the origin can sell, destinations that list them, role and reason columns', () => {
  const g = mkGame();
  const r = findTrades(g, null, parseRoutesQuery({ from: 'santos', cls: 'feeder', limit: '50' }).q);
  assert.ok(r.trades.length > 0);
  for (const t of r.trades) {
    assert.ok(['P', 'L'].includes(g.econ.roleAt('santos', t.good)) || g.harbors.santos.stock[t.good] > g.harbors.santos.target[t.good]);
    assert.ok(g.econ.row(t.to, t.good) >= 0 && canLoad(t.good, 'feeder').ok);
    assert.match(t.role, /^[PLI]→[PLI]$/); assert.ok('why' in t);
  }
  let ms = Infinity;   // best of 3: the suite runs files in parallel
  for (let i = 0; i < 3; i++) { const t0 = Date.now(); findTrades(g, null, parseRoutesQuery({ from: 'all', cls: 'coaster' }).q); ms = Math.min(ms, Date.now() - t0); }
  assert.ok(ms < 400, `from=all ${ms} ms`);
});
