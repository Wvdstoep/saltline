// Shared stubs for the VHF tests: a lane A `ww` stub with the frozen §9.5 interface (stationsOn / request / registerLock /
// statics / onEvent) and a minimal game (byId, send, event, broadcast, traffic). Positions near Rotterdam are game
// approximations; the Rozenburgsesluis numbers are the contract's synthetic seed (lift 3.6 / 24.0, ch 68 synthetic).
import { inHours } from '../shared/vhf.js';

export const T0 = Date.UTC(2026, 9, 9, 12, 20, 0);          // 14:20 in Amsterdam (CEST)
export const NIGHT = Date.UTC(2026, 9, 9, 21, 0, 0);        // 23:00 in Amsterdam
const H24 = { tz: 'Europe/Amsterdam', week: Array.from({ length: 7 }, () => [['00:00', '24:00']]) };
const DAY = { tz: 'Europe/Amsterdam', week: Array.from({ length: 7 }, () => [['06:00', '22:00']]) };

export const ROZ_LOCK = { id: 'fis:rzs', kind: 'lock', callName: 'Rozenburgsesluis', ch: 68, pos: [51.8905, 4.2270], h: 15, hours: H24, bridges: ['fis:rzs-b1', 'fis:rzs-b2'] };
export const BRIDGES = {
  'fis:rzs-b1': { id: 'fis:rzs-b1', name: 'Rozenburgsesluis north bridge', clr: 3.6, clrO: 24.0, lockId: 'fis:rzs', line: [[51.8925, 4.2262], [51.8925, 4.2282]], hours: H24 },
  'fis:rzs-b2': { id: 'fis:rzs-b2', name: 'Rozenburgsesluis south bridge', clr: 3.6, clrO: 24.0, lockId: 'fis:rzs', line: [[51.8885, 4.2262], [51.8885, 4.2282]], hours: H24 },
  'fis:botlek': { id: 'fis:botlek', callName: 'Botlekbrug', kind: 'bridge', ch: 18, pos: [51.8566, 4.3480], h: 15, hours: H24, clr: 14.0, clrO: 45.0 },
  'fis:testbrug': { id: 'fis:testbrug', callName: 'Testbrug', kind: 'bridge', ch: 20, pos: [51.8700, 4.3000], h: 15, hours: DAY, clr: 2.5, clrO: Infinity },
};
export const STATIONS = [ROZ_LOCK, BRIDGES['fis:botlek'], BRIDGES['fis:testbrug']];

export function makeWw({ now }) {
  const calls = { request: [], registerLock: [] };
  let n = 0, lockN = 0, fn = null;
  return {
    calls,
    stationsOn(ch, lat, lon) { return STATIONS.filter((s) => ch == null || s.ch === ch).map((s) => ({ ...s })); },
    statics() { return Object.values(BRIDGES); },
    request(id, ship, eta) {
      calls.request.push({ id, ship, eta });
      const b = BRIDGES[id];
      if (!b) return { ok: false, reason: 'unknown' };
      const h = inHours(b.hours, now());
      if (!h.open) return { ok: false, verdict: 'closed', reason: 'hours', next: h.next };
      const need = ship.need ?? (ship.ad + 0.3);
      if (need <= b.clr) return { ok: true, verdict: 'under', n: 0, clrNow: b.clr };
      if (need > b.clrO) return { ok: false, verdict: 'never', clrO: b.clrO, reason: 'never' };
      return { ok: true, verdict: 'opening', n: ++n, tOpen: now() + 262000 };   // §10.2.3: reaction 120 + warn 60 + lift 82
    },
    registerLock(id, ship, side) { calls.registerLock.push({ id, ship, side }); return { ok: true, chamber: 'A', n: ++lockN, tCycle: now() + 9 * 60000, fee: id === 'fis:rzs' ? 0 : 6 }; },
    onEvent(f) { fn = f; },
    emit(type, data) { fn?.(type, data); },
  };
}

export function player(id, name, lat, lon, o = {}) {
  return { id, name, online: true, inbox: [], events: [], ship: { lat, lon, hdg: o.hdg ?? 0, spd: o.spd ?? 5, cls: o.cls ?? 'sloop', ad: o.ad ?? 17.0, T: o.T ?? 1.9, L: o.L ?? 11, B: o.B ?? 3.6, type: o.type ?? 'sail_yacht' }, radio: o.radio };
}

export function makeGame(players = [], { traffic = [] } = {}) {
  const g = {
    byId: new Map(players.map((p) => [p.id, p])), chat: [], logs: [],
    send(p, m) { p.inbox.push(m); },
    event(p, kind, text, extra) { p.events.push({ kind, text, ...extra }); },
    broadcast(m) { g.chat.push(m); },
    sendYou() {},
    log(s) { g.logs.push(s); },
    traffic: { near: () => traffic },
  };
  return g;
}

/** Advance a fake clock in steps, ticking the radio. */
export function run(radio, clock, seconds, step = 0.5) {
  for (let t = 0; t < seconds; t += step) { clock.t += step * 1000; radio.tick(step); }
}
export const vhfOf = (p) => p.inbox.filter((m) => m.t === 'vhf');
