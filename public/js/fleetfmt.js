// v6 fleet: formatting helpers for the HQ and the harbour Office tab (docs/V6-FLEET-CONTRACTS.md §12.1). Import-free and
// DOM-free so Node tests import it directly (test/fleet-client.test.mjs). Shapes: VesselView / FleetView (§10.3).
const R = 6371000, D2R = Math.PI / 180;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function haversineM(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}
export const compass = (b) => COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8];
/** 'Rotterdam (Maasvlakte)' → 'Rotterdam'; 'IJmuiden / Amsterdam' → 'IJmuiden'. */
export const shortName = (name) => String(name || '').split(' (')[0].split(' / ')[0];
export const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
export const fmtCr = (n) => `${fmtN(n)} cr`;
/** '+6,120 cr' / '−930 cr' / '0 cr' */
export const fmtSigned = (n) => (!Number.isFinite(n) ? '—' : n > 0 ? `+${fmtN(n)} cr` : n < 0 ? `−${fmtN(-n)} cr` : '0 cr');
export const fmtT = (t) => (!Number.isFinite(t) ? '—' : t >= 100 ? `${fmtN(t)} t` : `${(Math.round(t * 10) / 10).toLocaleString('en-US')} t`);
export function fmtKm(m) { const km = m / 1000; return km >= 100 ? `${fmtN(km)} km` : `${(Math.round(km * 10) / 10).toLocaleString('en-US')} km`; }
/** '30 min' / '6 h 10 m' / '2 d 3 h' */
export function fmtDur(s) {
  if (!Number.isFinite(s)) return '—';
  s = Math.max(0, s);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 48 * 3600) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return m ? `${h} h ${m} m` : `${h} h`; }
  const d = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600); return h ? `${d} d ${h} h` : `${d} d`;
}
export function fmtAgo(t, now) { const s = Math.max(0, now - t); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; }

/** ETA in UTC: today → '14:20 UTC', another day → 'Thu 14:20 UTC', none → '—'. */
export function fmtEta(unixS, nowS) {
  if (!Number.isFinite(unixS)) return '—';
  const d = new Date(unixS * 1000), hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const same = Number.isFinite(nowS) && new Date(nowS * 1000).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  return same ? `${hm} UTC` : `${DAYS[d.getUTCDay()]} ${hm} UTC`;
}
/** Short 'hh:mm' for the map label (UTC). */
export function fmtHm(unixS) { if (!Number.isFinite(unixS)) return '—'; const d = new Date(unixS * 1000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }

/** The nearest harbour of `harbors` ([{id, name, lat, lon}]) to (lat, lon): { h, distM } | null. */
export function nearestHarbour(lat, lon, harbors) {
  let best = null, bd = Infinity;
  for (const h of harbors || []) { if (!h || !Number.isFinite(h.lat)) continue; const d = haversineM(lat, lon, h.lat, h.lon); if (d < bd) { bd = d; best = h; } }
  return best ? { h: best, distM: bd } : null;
}
/** Where she is, in words: 'Moored at Rotterdam, Waalhaven 3' / 'Laid up at Rotterdam' / '112 km NE of IJmuiden'. */
export function fmtPos(view, harbors) {
  if (!view) return '';
  const here = shortName(view.harborName || (harbors || []).find((h) => h.id === view.harbor)?.name || view.harbor || '');
  if (view.state === 'laid_up' || view.status === 'laidup') return `Laid up at ${here}`;
  if (view.state === 'docked' || view.harbor) return view.berthName ? `Moored at ${here}, ${view.berthName}` : `Moored at ${here}`;
  if (!Number.isFinite(view.lat) || !Number.isFinite(view.lon)) return 'At sea';
  const n = nearestHarbour(view.lat, view.lon, harbors);
  if (!n) return `${Math.abs(view.lat).toFixed(2)}° ${view.lat >= 0 ? 'N' : 'S'} ${Math.abs(view.lon).toFixed(2)}° ${view.lon >= 0 ? 'E' : 'W'}`;
  if (n.distM < 1000) return `Off ${shortName(n.h.name)}`;
  return `${fmtKm(n.distM)} ${compass(bearingDeg(n.h.lat, n.h.lon, view.lat, view.lon))} of ${shortName(n.h.name)}`;
}
/** '54.21° N 3.05° E' */
export function fmtLatLon(lat, lon) { return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`; }
/** The task line: the server's text plus the ETA in the viewer's words ('Freight … · ETA Thu 14:20 UTC'). */
export function fmtTask(view, nowS) {
  const t = view && view.task; if (!t) return '';
  let s = t.text || '';
  if (Number.isFinite(t.etaS)) s += ` · ETA ${fmtEta(t.etaS, nowS)}`;
  if (Number.isFinite(t.leftKm) && t.phase === 'sailing') s += ` · ${fmtKm(t.leftKm * 1000)} to go`;
  return s;
}
export function stateLabel(state) { return ({ at_sea: 'At sea', docked: 'Moored', anchored: 'At anchor', laid_up: 'Laid up' })[state] || 'At sea'; }
export function chipClass(state) { return ({ at_sea: 'st-sea', docked: 'st-dock', anchored: 'st-anchor', laid_up: 'st-laid' })[state] || 'st-sea'; }
/** Map colours by state (teal at sea, amber anchored, blue moored, grey laid up). */
export function stateColor(state) { return ({ at_sea: '#2ec4b6', docked: '#5aa2ff', anchored: '#f2b134', laid_up: '#8ea9bf' })[state] || '#2ec4b6'; }
/** At most n points, first and last kept. */
export function decimate(route, n) {
  if (!Array.isArray(route)) return [];
  if (route.length <= n) return route.slice();
  if (n < 2) return [route[0]];
  const out = [], step = (route.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(route[Math.round(i * step)]);
  return out;
}
/** Bounds of points ([lat, lon] or {lat, lon}) with padFrac on every side and at least minSpanDeg in each direction. */
export function fitBounds(points, padFrac = 0.15, minSpanDeg = 2) {
  const ll = (p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : p);
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const raw of points || []) { const p = ll(raw); if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue; latMin = Math.min(latMin, p.lat); latMax = Math.max(latMax, p.lat); lonMin = Math.min(lonMin, p.lon); lonMax = Math.max(lonMax, p.lon); }
  if (!Number.isFinite(latMin)) { latMin = 50; latMax = 56; lonMin = 0; lonMax = 8; }
  let dLat = latMax - latMin, dLon = lonMax - lonMin;
  const cLat = (latMin + latMax) / 2, cLon = (lonMin + lonMax) / 2;
  dLat = Math.max(minSpanDeg, dLat * (1 + 2 * padFrac)); dLon = Math.max(minSpanDeg, dLon * (1 + 2 * padFrac));
  return { latMin: Math.max(-85, cLat - dLat / 2), latMax: Math.min(85, cLat + dLat / 2), lonMin: cLon - dLon / 2, lonMax: cLon + dLon / 2 };
}
/** Bar fill 0..1 and its tone ('good' | 'warn' | 'bad') for fuel / hull. */
export function barOf(v, max) { const f = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0; return { f, tone: f < 0.2 ? 'bad' : f < 0.45 ? 'warn' : 'good' }; }
/** The running cost of a ship card: 'now 55 cr/h' / 'storage 32 cr/day' / 'no running costs'. */
export function fmtCost(c) { if (!c) return ''; return c.kind === 'wages' ? `now ${fmtN(c.crPerH)} cr/h` : c.kind === 'storage' ? `storage ${fmtN(c.crPerDay)} cr/day` : 'no running costs'; }
/** Sea km ≈ great circle × 1.25 at service speed (the "Sail to…" estimate). */
export function etaEstimate(fromLat, fromLon, toLat, toLon, kn) { const km = (haversineM(fromLat, fromLon, toLat, toLon) / 1000) * 1.25; return { km, h: kn > 0 ? km / (kn * 1.852) : Infinity }; }
/** Ledger category → label. */
export const CAT_LABEL = { income: 'Income', costs: 'Running costs', fuel: 'Fuel', port: 'Harbour dues & berths', tugs: 'Tugs & tows', repairs: 'Repairs & service', wages: 'Wages', storage: 'Boat storage', fees: 'Office fees', arrears: 'Unpaid bills settled', ships: 'Ships bought / sold' };
