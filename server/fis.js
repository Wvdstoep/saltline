// FIS registry file (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §3.3): pack / unpack of server/waterworks/nl-fis.json.gz and the
// lazy loader. The shipped file is a compact, de-duplicated form of the §4.2 / §4.8.1 game objects (short keys, shared
// schedule table, integer-delta polylines); `unpackFis` restores the full game objects. Plain ESM, no deps.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const D2R = Math.PI / 180;
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const mPerLon = (lat) => 111320 * Math.cos(lat * D2R);
export const FIS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'waterworks', 'nl-fis.json.gz');
export const FIS_ATTRIBUTION = 'Bridges & locks NL: © Rijkswaterstaat / Vaarweginformatie.nl (CC0)';

const MOV = ['fixed', 'bascule', 'bascule2', 'lift', 'swing', 'pontoon', 'draw', 'retract'];
const CALL = ['none', 'vhf', 'button', 'phone'];
const OPS = [null, 'RWS', 'Port of Rotterdam', 'Port', 'Province', 'Municipality', 'Water board', 'Other'];
const DATUMS = ['NAP', 'KP', 'MHWS', 'LAT', 'MSL'];
const INF = 999;                                  // open clearance "unlimited" in the file
export const UNKNOWN_W = 6;                       // FIS opening without a width (Width 0 / missing)
const num = (v) => (v == null ? null : v >= INF ? Infinity : v);
const fid = (id) => (typeof id === 'string' && id.startsWith('fis:') ? Number(id.slice(4)) : id);
const sid = (n) => (n == null ? null : 'fis:' + n);

// ------------------------------------------------------------------------------------------------ polyline codec
export function encodeLine(pts) {
  const out = []; let la = 0, lo = 0;
  for (const [a, b] of pts) { const A = Math.round(a * 1e5), B = Math.round(b * 1e5); out.push(A - la, B - lo); la = A; lo = B; }
  return out;
}
export function decodeLine(q) {
  const pts = []; let la = 0, lo = 0;
  for (let i = 0; i + 1 < q.length; i += 2) { la += q[i]; lo += q[i + 1]; pts.push([la / 1e5, lo / 1e5]); }
  return pts;
}
/** Synthetic deck line through p with the given bearing (deg) and half length (m). */
export function deckLine(p, brg, half) {
  const kx = mPerLon(p[0]);
  const off = (d) => [r5(p[0] + (d * Math.cos(brg * D2R)) / 110540), r5(p[1] + (d * Math.sin(brg * D2R)) / kx)];
  return [off(-half), off(half)];
}
function bearingOf(line) { const [a, b] = line; return Math.atan2((b[1] - a[1]) * mPerLon(a[0]), (b[0] - a[0]) * 110540) / D2R; }
function lengthOf(line) { const [a, b] = line; return Math.hypot((b[1] - a[1]) * mPerLon(a[0]), (b[0] - a[0]) * 110540); }

// ------------------------------------------------------------------------------------------------ pack
/** Full normalised data (scripts/fetch-fis.mjs normalise) → compact file object. */
export function packFis(d) {
  const sched = [], skey = new Map();
  const schedOf = (o) => {
    if (!o.hours && !(o.blocks && o.blocks.length) && !o.slots) return undefined;
    const s = { h: o.hours ? { w: o.hours.week, n: o.hours.onRequestNight || undefined } : undefined, b: o.blocks && o.blocks.length ? o.blocks : undefined, s: o.slots || undefined };
    const k = JSON.stringify(s); if (!skey.has(k)) { skey.set(k, sched.length); sched.push(s); }
    return skey.get(k);
  };
  const B = d.bridges.map((b) => {
    const o = { i: fid(b.id), n: b.name, p: b.p, r: Math.round(bearingOf(b.line) * 10) / 10, L: Math.round(lengthOf(b.line) * 10) / 10,
      s: b.spans.map((s) => [MOV.indexOf(s.mov), s.clr, s.clrO == null ? null : s.clrO === Infinity ? INF : s.clrO, s.w, s.a, s.b, s.rec ? 1 : 0]) };
    if (b.datum !== 'NAP') o.d = DATUMS.indexOf(b.datum);
    if (b.e) o.e = b.e;
    if (b.vhf) o.v = b.vhf;
    if (b.call !== 'none') o.c = CALL.indexOf(b.call);
    const h = schedOf(b); if (h !== undefined) o.h = h;
    if (b.hoursE) o.he = b.hoursE;
    if (b.remote) o.rm = 1;
    if (b.lockId) { o.lk = fid(b.lockId); if (b.head != null) o.hd = b.head; }
    if (b.pairedWith) o.pw = fid(b.pairedWith);
    if (b.operator) o.op = OPS.indexOf(b.operator);
    if (b.section != null) o.sc = b.section;
    if (b.mhw != null) o.mh = b.mhw;
    return o;
  });
  const L = d.locks.map((l) => {
    const o = { i: fid(l.id), n: l.name, p: l.p, g: l.ring ? encodeLine(l.ring) : undefined,
      c: l.chambers.map((c) => ({ i: c.id, f: c.fis, k: c.kind, l: c.len, w: c.wid, u: c.sillUp, d: c.sillDn, e: c.sillE || undefined, a: c.axis, gt: c.gates[0].type, nt: c.note || undefined })),
      sd: l.sides.map((s) => [s.name, s.level]) };
    if (l.doubleActing) o.da = 1;
    if (l.vhf) o.v = l.vhf;
    o.cl = CALL.indexOf(l.call);
    const h = schedOf(l); if (h !== undefined) o.h = h;
    if (l.bridges.length) o.br = l.bridges.map(fid);
    if (l.operator) o.op = OPS.indexOf(l.operator);
    if (l.remote) o.rm = 1;
    if (l.section != null) o.sc = l.section;
    return o;
  });
  const S = d.sections.map((s) => ({ i: s.id, j: s.j, q: encodeLine(s.pts), m: s.len || undefined, lim: s.lim }));
  const T = d.harbours.map((h) => [fid(h.id), h.name, h.p, h.long, h.short, h.fuel ? 1 : 0]);
  return { v: 1, fmt: 'fis-pack-1', geogeneration: d.geogeneration, publication: d.publication, fetchedAt: d.fetchedAt, attribution: d.attribution,
    licence: d.licence, source: d.source, sched, B, L, S, T };
}

// ------------------------------------------------------------------------------------------------ unpack
function hoursOfSched(s) {
  if (!s || !s.h) return null;
  return { tz: 'Europe/Amsterdam', week: s.h.w, holidays: 'sunday', onRequestNight: s.h.n || null };
}
/** FIS gives each opening as a point; when the projections overlap (openings side by side along a skewed synthetic
 *  line) the spans are laid out in FIS order, 10 m piers between them, centred on the line. Returns the line length. */
export function layoutSpans(spans, L) {
  const ov = spans.some((s, i) => s.b - s.a < s.w - 0.01 || spans.some((t, j) => j > i && s.a < t.b && t.a < s.b));
  if (!ov) return L;
  const total = spans.reduce((a, s) => a + s.w, 0) + 10 * (spans.length - 1);
  const len = Math.max(L, total + 40);
  let x = (len - total) / 2;
  for (const s of spans) { s.a = Math.round(x * 100) / 100; s.b = Math.round((x + s.w) * 100) / 100; x += s.w + 10; }
  return len;
}
export function unpackBridge(o, sched = []) {
  const sc = o.h != null ? sched[o.h] : null;
  const spans = o.s.map(([m, clr, clrO, w, a, b, rec], id) => ({ id, a, b, mov: MOV[m], clr, clrO: clrO == null ? null : num(clrO), w: w > 0 ? w : UNKNOWN_W, hinge: null, pivot: MOV[m] === 'swing' ? 0.5 : null, rec }));
  const L = layoutSpans(spans, o.L);
  const line = deckLine(o.p, o.r, L / 2);
  return {
    id: sid(o.i), name: o.n, kind: 'road', src: 'fis', e: o.e || 0, p: o.p, line, lineSrc: 'synthetic', deckW: 12, structure: 'girder',
    spans,
    datum: DATUMS[o.d || 0], kp: null, mhw: o.mh ?? null, vhf: o.v || null, call: CALL[o.c || 0], callName: o.n.replace(/^Brug over /, ''),
    hours: hoursOfSched(sc), hoursE: o.he || 0, blocks: (sc && sc.b) || [], slots: (sc && sc.s) || null, remote: !!o.rm,
    lockId: o.lk ? sid(o.lk) : null, head: o.hd ?? null, pairedWith: o.pw ? sid(o.pw) : null, fee: 0, notes: [], operator: OPS[o.op || 0], section: o.sc ?? null,
  };
}
export function unpackLock(o, sched = []) {
  const sc = o.h != null ? sched[o.h] : null;
  return {
    id: sid(o.i), name: o.n, callName: o.n, src: 'fis', e: 0, p: o.p, ring: o.g ? decodeLine(o.g) : null,
    chambers: o.c.map((c) => ({ id: c.i, fis: c.f, kind: c.k, len: c.l, wid: c.w, sillUp: c.u, sillDn: c.d, sillE: c.e || 0, axis: c.a,
      gates: [{ head: 0, type: c.gt, at: 0 }, { head: 1, type: c.gt, at: c.l }], culvert: null, bollards: { step: 15, floating: false, levels: 3 }, waiting: [], note: c.nt || null })),
    sides: o.sd.map(([name, level]) => ({ name, level })), doubleActing: !!o.da, vhf: o.v || null, call: CALL[o.cl || 0],
    hours: hoursOfSched(sc), blocks: (sc && sc.b) || [], fee: null, bridges: (o.br || []).map(sid), notices: [], operator: OPS[o.op || 0], remote: !!o.rm, section: o.sc ?? null,
  };
}
export function unpackFis(f) {
  if (!f || f.fmt !== 'fis-pack-1') throw new Error('not a fis-pack-1 file');
  return {
    v: f.v, geogeneration: f.geogeneration, publication: f.publication, fetchedAt: f.fetchedAt, attribution: f.attribution || FIS_ATTRIBUTION, licence: f.licence, source: f.source,
    bridges: f.B.map((o) => unpackBridge(o, f.sched)),
    locks: f.L.map((o) => unpackLock(o, f.sched)),
    sections: f.S.map((s) => ({ id: s.i, j: s.j, pts: decodeLine(s.q), len: s.m || null, lim: s.lim || null })),
    harbours: f.T.map(([i, name, p, long, short, fuel]) => ({ id: sid(i), name, p, long, short, fuel: !!fuel })),
  };
}

// ------------------------------------------------------------------------------------------------ load
let cached = null;
/** Load and unpack the shipped registry (lazy, once). Returns null when the file is missing or SALTLINE_WW_OFF=1. */
export function loadFis(file = FIS_FILE) {
  if (process.env.SALTLINE_WW_OFF === '1') return null;
  if (cached && cached.file === file) return cached.data;
  if (!fs.existsSync(file)) return null;
  const data = unpackFis(JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')));
  cached = { file, data };
  return data;
}
/** Small subset (objects within bbox [s, w, n, e]) for fixtures and tests. */
export function subsetFis(data, [s, w, n, e]) {
  const inb = (p) => p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e;
  return { ...data, bridges: data.bridges.filter((b) => inb(b.p)), locks: data.locks.filter((l) => inb(l.p)),
    sections: data.sections.filter((x) => x.pts.some(inb)), harbours: data.harbours.filter((h) => inb(h.p)) };
}
