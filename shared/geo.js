// Geodesy helpers shared by server and client. Real metres unless stated otherwise.
import { GEO } from './constants.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * GEO.EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

export function destination(lat, lon, bearingDeg, distM) {
  const d = distM / GEO.EARTH_R, b = bearingDeg * D2R, p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: wrapLon(l2 * R2D) };
}

export function wrapLon(lon) {
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  return lon;
}

export function clampLat(lat) { return Math.max(-85, Math.min(85, lat)); }

// Local projection about a floating origin, in GAME UNITS (real metres / SCALE). x = east, z = south, so north
// is -z (a Three.js camera looking down -z sees north "ahead" at heading 0). Longitude scale uses the POINT's own
// latitude so neighbouring terrain tiles share exact vertices; skew is negligible within 20 km of the origin.
export function toLocal(lat, lon, origin) {
  const k = Math.cos(lat * D2R);
  const dlon = wrapLon(lon - origin.lon);
  return {
    x: (dlon * GEO.M_PER_DEG_LON_EQ * k) / GEO.SCALE,
    z: (-(lat - origin.lat) * GEO.M_PER_DEG_LAT) / GEO.SCALE,
  };
}

export function fromLocal(x, z, origin) {
  const lat = origin.lat - (z * GEO.SCALE) / GEO.M_PER_DEG_LAT;
  const k = Math.cos(lat * D2R) || 1e-6;
  return { lat, lon: wrapLon(origin.lon + (x * GEO.SCALE) / (GEO.M_PER_DEG_LON_EQ * k)) };
}

// Distance in game units between two lat/lon points (planar approximation; fine for interaction ranges).
export function unitsBetween(lat1, lon1, lat2, lon2) {
  return haversine(lat1, lon1, lat2, lon2) / GEO.SCALE;
}

export function fmtDMS(v, isLat) {
  const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return `${String(d).padStart(isLat ? 2 : 3, '0')}°${m.toFixed(2).padStart(5, '0')}'${hemi}`;
}

export function fmtDistance(metres) {
  const nm = metres / 1852;
  return nm >= 10 ? `${nm.toFixed(0)} nm` : `${nm.toFixed(1)} nm`;
}

export function normDeg(d) { return ((d % 360) + 360) % 360; }
export function angleDiff(a, b) { // shortest signed difference b - a in degrees
  let d = (b - a + 540) % 360 - 180;
  return d;
}
