// Interiors v2 — baked vertex light (docs/INTERIORS-V2-CONTRACT.md §5.1, Lane R). Pure: no three.js, no DOM.
//
// bakeLight(pos, nrm, roomIdx, rooms, lights, windows) → Float32Array(4 n): per vertex
//   P  practical light from the fixtures of the vertex's own room (+ 25 % bleed from rooms it opens onto),
//   D  daylight from the room's windows (window area ÷ floor area, falling off with distance from each window),
//   E  emergency light (fixtures with em: true),
//   N  practical light at night (fixtures 'dim' at half, 'off' none; the bridge's red night lights negative = red).
// The materials combine them per mode: col × (ambient + uLights·P + uDay·D + uEmerg·E). No shadows (Q10): the room is
// the light's world, so light never passes through walls. Deterministic.
const SAT = (v) => (v <= 0 ? 0 : 1.15 * (1 - Math.exp(-v / 1.15)));   // soft knee: many fixtures never blow out

/** Room light tables built once per bake: fixtures per room, windows per room, neighbour bleed. */
export function lightTables(rooms, lights, doors = []) {
  const idx = new Map(rooms.map((r, i) => [r.id, i]));
  const per = rooms.map(() => []), em = rooms.map(() => []), win = rooms.map(() => []), nightW = rooms.map(() => []), nightR = rooms.map(() => []);
  for (const l of lights) {
    const i = idx.get(l.room); if (i == null) continue;
    if (l.em) { em[i].push(l); continue; }
    if (l.night === 'red') { nightR[i].push(l); continue; }
    per[i].push(l);
    if (l.night === 'on') nightW[i].push(l); else if (l.night === 'dim') nightW[i].push({ ...l, lm: l.lm * 0.45 });
  }
  rooms.forEach((r, i) => {
    for (const w of r.windows || []) {
      const ns = w.side === 'n' || w.side === 's', c = { n: r.z0, s: r.z1, w: r.x0, e: r.x1 }[w.side];
      win[i].push({ ns, c, a: w.from, b: w.to, bottom: w.bottom ?? 1, top: w.top ?? 2, area: (w.to - w.from) * ((w.top ?? 2) - (w.bottom ?? 1)), dir: { n: 1, s: -1, w: 1, e: -1 }[w.side] });
    }
  });
  // practical level of a room as a whole (for the bleed through open doors)
  const level = rooms.map((r, i) => { const A = Math.max(1, (r.x1 - r.x0) * (r.z1 - r.z0)); let s = 0; for (const l of per[i]) s += l.lm; return Math.min(1, s / (A * 60)); });
  const bleed = rooms.map(() => 0);
  for (const d of doors) {
    const a = idx.get(d.a), b = d.b != null ? idx.get(d.b) : null;
    if (a == null || b == null) continue;
    bleed[a] = Math.max(bleed[a], 0.25 * level[b]); bleed[b] = Math.max(bleed[b], 0.25 * level[a]);
  }
  return { per, em, win, bleed, nightW, nightR };
}

function fixtureTerm(list, x, y, z, nx, ny, nz) {
  let s = 0;
  for (const l of list) {
    const dx = l.x - x, dy = (l.y ?? y + 2) - y, dz = l.z - z;
    const d2 = dx * dx + dy * dy + dz * dz + 0.25, d = Math.sqrt(d2);
    const lam = (nx * dx + ny * dy + nz * dz) / d;           // Lambert (the fixture seen from the surface)
    const k = 0.35 + 0.65 * (lam > 0 ? lam : 0);              // a little wrap: ceilings and back faces are not black
    s += (l.lm / 450) * k * (0.95 / (1 + d2 * 0.28));
  }
  return s;
}

/**
 * pos, nrm: Float32Array(3 n); roomIdx: Int32Array(n) (−1 = outside any room: open decks get daylight only).
 * rooms: the plan rooms; lights: plan.lights; tables: optional lightTables(...) result (shared between chunks).
 */
export function bakeLight(pos, nrm, roomIdx, rooms, lights, windows = null, tables = null) {
  const n = roomIdx.length, out = new Float32Array(4 * n);
  const T = tables || lightTables(rooms, lights);
  void windows;
  for (let v = 0; v < n; v++) {
    const i = roomIdx[v], x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2], nx = nrm[3 * v], ny = nrm[3 * v + 1], nz = nrm[3 * v + 2];
    if (i < 0 || rooms[i].open) { out[4 * v] = 0.5; out[4 * v + 1] = 1.0; out[4 * v + 2] = 0.2; out[4 * v + 3] = 0.35; continue; }
    const r = rooms[i];
    const P = fixtureTerm(T.per[i], x, y, z, nx, ny, nz) + T.bleed[i];
    const E = fixtureTerm(T.em[i], x, y, z, nx, ny, nz) * 2.5 + 0.03;
    let D = 0;
    const A = Math.max(1, (r.x1 - r.x0) * (r.z1 - r.z0));
    for (const w of T.win[i]) {
      // distance into the room from the window plane, and along it from the opening
      const into = (w.ns ? z - w.c : x - w.c) * w.dir, along = w.ns ? x : z;
      const off = along < w.a ? w.a - along : along > w.b ? along - w.b : 0;
      const dist = Math.max(0, into) + off * 0.7;
      const facing = w.ns ? nz * w.dir : nx * w.dir;          // surfaces facing away from the window get less
      D += (w.area / A) * 4 * Math.exp(-dist / 3.2) * (0.55 + 0.45 * Math.max(0, facing)) * (into < -0.05 ? 0 : 1);
    }
    const NW = fixtureTerm(T.nightW[i], x, y, z, nx, ny, nz) + T.bleed[i] * 0.5, NR = fixtureTerm(T.nightR[i], x, y, z, nx, ny, nz);
    out[4 * v] = SAT(P); out[4 * v + 1] = SAT(D); out[4 * v + 2] = SAT(E); out[4 * v + 3] = NR > NW ? -SAT(NR) : SAT(NW);
  }
  return out;
}

/** The mode table (§5.1): uniform values for day / night / emergency (and the bridge's red night lights). */
export function lightMode(mode, { dayK = 1, gloomK = 0 } = {}) {
  const uDay = dayK * (1 - 0.6 * gloomK);
  if (mode === 'emergency') return { uLights: 0, uNight: 0, uDay, uEmerg: 1, uAmb: 0.025, uScreen: 0.15 };
  if (mode === 'night') return { uLights: 1, uNight: 1, uDay, uEmerg: 0.15, uAmb: 0.035, uScreen: 0.55 };
  return { uLights: 1, uNight: 0, uDay, uEmerg: 0.1, uAmb: 0.06, uScreen: 1 };
}
