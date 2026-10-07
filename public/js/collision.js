// Ship collision against harbour geometry (SDF) and other ships (OBB), docs/V3-CONTRACTS.md §5.
// Works in real metres about the ship's own lat/lon: x = east, z = south, heading 0 = north (-z).
import { GEO, SHIP_CLASSES } from '/shared/constants.js';
import { isObstacle } from './harborgeom.js';

const D2R = Math.PI / 180;
const MS_TO_KN = 1 / GEO.KN_TO_MS;
// hull sample points as fractions of (length along the heading, beam to starboard): bow, stern, 2 midships, 4 quarters
const HULL_PTS = [[0.48, 0], [-0.48, 0], [0, 0.5], [0, -0.5], [0.25, 0.45], [0.25, -0.45], [-0.25, 0.47], [-0.25, -0.47]];
const MARGIN = 0.05;        // metres of clearance left after a push-out
const CLEAR_M = 0.4;        // a contact ends once the hull is this far from the wall …
const CLEAR_S = 0.75;       // … or has not touched it for this long
const MAX_ITER = 4;

const states = new WeakMap(); // ship object -> per-ship contact bookkeeping

function stateOf(ship) {
  let st = states.get(ship);
  if (!st) { st = { contact: false, clearT: 0, lastWater: null, ships: new Map() }; states.set(ship, st); }
  return st;
}

/** Deepest hull penetration into harbour obstacles. Returns null when no patch is near, else {d, gx, gz, mask, px, pz}. */
function deepestPenetration(ship, L, B, geoms, mLat, mLon) {
  const h = ship.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
  let worst = null;
  for (const [a, b] of HULL_PTS) {
    const px = fx * L * a + rx * B * b, pz = fz * L * a + rz * B * b;
    const s = geoms.sdfAt(ship.lat - pz / mLat, ship.lon + px / mLon);
    if (!s) continue;
    if (!worst || s.d < worst.d) worst = { d: s.d, gx: s.gx, gz: s.gz, mask: s.mask, px, pz };
  }
  return worst;
}

/** Separating-axis test of two oriented rectangles; returns the minimum translation {x, z} to move A out of B, or null. */
function obbSeparation(ax, az, ahdg, aL, aB, bx, bz, bhdg, bL, bB) {
  const ha = ahdg * D2R, hb = bhdg * D2R;
  const axes = [[Math.sin(ha), -Math.cos(ha)], [Math.cos(ha), Math.sin(ha)], [Math.sin(hb), -Math.cos(hb)], [Math.cos(hb), Math.sin(hb)]];
  const half = [[aL / 2, aB / 2], [bL / 2, bB / 2]];
  const dx = bx - ax, dz = bz - az;
  let best = null;
  for (let i = 0; i < 4; i++) {
    const [ux, uz] = axes[i];
    // projected half-extents of each box on this axis
    const ra = Math.abs(ux * axes[0][0] + uz * axes[0][1]) * half[0][0] + Math.abs(ux * axes[1][0] + uz * axes[1][1]) * half[0][1];
    const rb = Math.abs(ux * axes[2][0] + uz * axes[2][1]) * half[1][0] + Math.abs(ux * axes[3][0] + uz * axes[3][1]) * half[1][1];
    const dist = dx * ux + dz * uz;
    const overlap = ra + rb - Math.abs(dist);
    if (overlap <= 0) return null;
    if (!best || overlap < best.overlap) best = { overlap, ux: dist > 0 ? -ux : ux, uz: dist > 0 ? -uz : uz }; // push A away from B
  }
  return { x: best.ux * best.overlap, z: best.uz * best.overlap, overlap: best.overlap, nx: best.ux, nz: best.uz };
}

/**
 * Resolve the local ship against harbour obstacles and other ships. Mutates ship.lat/lon/spd.
 * @param ship {lat, lon, hdg, spd (kn)} local ship state
 * @param cls SHIP_CLASSES entry (or its id)
 * @param geoms HarborGeomSet (may be empty)
 * @param dt real seconds since the last call
 * @param others [{id, lat, lon, hdg, spd, length, beam}] players + AI + cutters (docked / moored ones excluded by the caller)
 * @returns {{hit: boolean, speedKn: number, kind: 'quay'|'breakwater'|'ship'|null, contact: boolean, mask: number|null}}
 */
export function resolveShip(ship, cls, geoms, dt, others) {
  const C = (typeof cls === 'string' ? SHIP_CLASSES[cls] : cls) || SHIP_CLASSES.coaster;
  const L = C.length || 30, B = C.beam || 8;
  const st = stateOf(ship);
  const out = { hit: false, speedKn: 0, kind: null, contact: false, mask: null };
  if (!Number.isFinite(ship.lat) || !Number.isFinite(ship.lon)) return out;
  dt = Math.max(0, Math.min(0.5, Number(dt) || 0));
  const mLat = GEO.M_PER_DEG_LAT, mLon = GEO.M_PER_DEG_LON_EQ * Math.max(0.05, Math.cos(ship.lat * D2R));
  const near = geoms && geoms.size > 0 && geoms.entryNear ? geoms.entryNear(ship.lat, ship.lon, L) : null;
  const useSdf = !!near;
  const spd0 = ship.spd;
  const h = ship.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h);

  let wallHitThisFrame = false, wallNormal = null, wallMask = null, shipHitThisFrame = false, shipClosing = 0;
  const touchedShips = new Set();

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let moved = false;
    // --- harbour obstacles ---------------------------------------------------------------------------------
    if (useSdf) {
      const pen = deepestPenetration(ship, L, B, geoms, mLat, mLon);
      if (pen && pen.d < 0) {
        const push = -pen.d + MARGIN;
        ship.lon += (pen.gx * push) / mLon;
        ship.lat -= (pen.gz * push) / mLat;
        wallHitThisFrame = true; wallNormal = pen; wallMask = pen.mask; moved = true;
      }
    }
    // --- other ships ---------------------------------------------------------------------------------------
    if (others && others.length) {
      for (const o of others) {
        if (!o || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) continue;
        const oL = o.length || 30, oB = o.beam || 8;
        const ox = (o.lon - ship.lon) * mLon, oz = -(o.lat - ship.lat) * mLat;
        if (Math.hypot(ox, oz) > (L + oL) / 2 + 2) continue;
        const sep = obbSeparation(0, 0, ship.hdg, L, B, ox, oz, o.hdg || 0, oL, oB);
        if (!sep) continue;
        ship.lon += (sep.x + sep.nx * 0.1) / mLon;
        ship.lat -= (sep.z + sep.nz * 0.1) / mLat;
        moved = true; shipHitThisFrame = true; touchedShips.add(o.id);
        // closing speed along the contact normal (our velocity relative to theirs), m/s
        const vx = fx * ship.spd * GEO.KN_TO_MS - Math.sin((o.hdg || 0) * D2R) * (o.spd || 0) * GEO.KN_TO_MS;
        const vz = fz * ship.spd * GEO.KN_TO_MS + Math.cos((o.hdg || 0) * D2R) * (o.spd || 0) * GEO.KN_TO_MS;
        shipClosing = Math.max(shipClosing, -(vx * sep.nx + vz * sep.nz));
        if (!st.ships.has(o.id)) { st.ships.set(o.id, { fresh: true, clearT: 0 }); }
      }
    }
    if (!moved) break;
  }

  // --- last resort: never leave the ship inside an obstacle -------------------------------------------------
  if (useSdf) {
    const pen = deepestPenetration(ship, L, B, geoms, mLat, mLon);
    if (pen && pen.d < -0.01) {
      if (st.lastWater) { ship.lat = st.lastWater.lat; ship.lon = st.lastWater.lon; }
      else { const push = -pen.d * 2 + 1; ship.lon += (pen.gx * push) / mLon; ship.lat -= (pen.gz * push) / mLat; }
      ship.spd = 0; wallHitThisFrame = true; wallNormal = pen; wallMask = pen.mask;
    } else if (!pen || pen.d > 0.25) st.lastWater = { lat: ship.lat, lon: ship.lon };
  } else st.lastWater = { lat: ship.lat, lon: ship.lon };

  // --- velocity response + contact bookkeeping (walls) ------------------------------------------------------
  if (wallHitThisFrame) {
    const fdotg = fx * wallNormal.gx + fz * wallNormal.gz; // forward · outward normal (< 0: the bow points into the wall)
    const movingIn = ship.spd * fdotg < 0;
    const kind = wallMask === 3 ? 'breakwater' : 'quay';
    out.contact = true; out.mask = wallMask; out.kind = kind;
    st.clearT = 0;
    if (!st.contact) {
      st.contact = true;
      const impactKn = Math.abs(spd0) * (0.4 + 0.6 * Math.abs(fdotg));
      const closing = Math.max(0, -(fx * spd0 * GEO.KN_TO_MS * wallNormal.gx + fz * spd0 * GEO.KN_TO_MS * wallNormal.gz));
      if (impactKn >= 0.4 || closing > 0.2) {
        if (movingIn) ship.spd *= 1 - fdotg * fdotg; // remove the component into the wall
        ship.spd *= 0.4;
        out.hit = true; out.speedKn = Math.round(impactKn * 10) / 10;
      } else if (movingIn) ship.spd *= 0.5;
    } else if (movingIn) {
      ship.spd *= Math.max(0, 1 - 2.5 * Math.abs(fdotg) * dt); // scraping along: friction, the hull slides
    }
  } else if (st.contact) {
    st.clearT += dt;
    const pen = useSdf ? deepestPenetration(ship, L, B, geoms, mLat, mLon) : null;
    if (!pen || pen.d > CLEAR_M || st.clearT > CLEAR_S) { st.contact = false; st.clearT = 0; }
  }

  // --- ships -------------------------------------------------------------------------------------------------
  if (shipHitThisFrame) {
    out.contact = true;
    let fresh = false;
    for (const id of touchedShips) { const c = st.ships.get(id); if (c?.fresh) { c.fresh = false; fresh = true; } c.clearT = 0; }
    if (fresh) {
      const impactKn = Math.max(shipClosing * MS_TO_KN, Math.abs(spd0) * 0.5);
      if (impactKn >= 0.4) { ship.spd *= 0.4; if (!out.hit) { out.hit = true; out.speedKn = Math.round(impactKn * 10) / 10; out.kind = 'ship'; } }
    }
  }
  for (const [id, c] of st.ships) { if (touchedShips.has(id)) continue; c.clearT += dt; if (c.clearT > CLEAR_S) st.ships.delete(id); }
  if (!Number.isFinite(ship.spd)) ship.spd = 0;
  return out;
}

/** Hull-contact helper for callers that only want to know whether a point is on an obstacle. */
export function pointBlocked(geoms, lat, lon) { const s = geoms?.sdfAt?.(lat, lon); return !!s && s.d < 0 && isObstacle(s.mask); }
