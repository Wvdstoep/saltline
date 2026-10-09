#!/usr/bin/env node
// Operator script: fetch the Rijkswaterstaat Vaarweginformatie FIS dataservice (v1.4, CC0) and write the compact
// waterworks registry server/waterworks/nl-fis.json.gz (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §3.3, §4.2, §4.8.1).
// No npm deps. Single connection, 100 per page, >= 1 s between requests.
//
//   node scripts/fetch-fis.mjs                       fetch everything, normalise, write the .json.gz
//   node scripts/fetch-fis.mjs --raw DIR             also keep the raw entity dumps in DIR (one JSON array per entity)
//   node scripts/fetch-fis.mjs --from-raw DIR        normalise an earlier raw dump (no network)
//   node scripts/fetch-fis.mjs --probe [--from-raw DIR]   print Botlekbrug, Calandbrug Rozenburg, Rozenburgsesluis
//   node scripts/fetch-fis.mjs --out FILE            output path (default server/waterworks/nl-fis.json.gz)
//
// Field mapping (recorded by the production probe of 2026-10-09, geogeneration 4951 — see the doc §3.4 note):
//   endpoint  https://www.vaarweginformatie.nl/wfswms/dataservice/1.4/geogeneration  → {GeoGeneration, PublicationDate}
//             https://www.vaarweginformatie.nl/wfswms/dataservice/1.4/<gen>/<entity>?offset=&count=  → {TotalCount, Result[]}
//   bridge    Id Name Geometry(WKT POINT) Referencelevel(NAP|KP|MP|SP|PP|BP|UNSPECIFIED) MhwReferenceLevel(CANAL|RIVER)
//             MhwOffset CanOpen IsRemoteControlled NumberOfOpenings OperatingTimesId AdministrationId FairwaySectionId
//             RouteId RouteKmBegin Rotation RelatedBuildingComplexName PhoneNumber Note
//   opening   ParentId(bridge) Number Type(VST HEF BC KLP DBC RBC OPH DOP DR DDR PDR PON ROL OKW) HeightClosed HeightOpened
//             (above the bridge's Referencelevel) ClearanceHeightClosed/Opened (at MHW for RIVER bridges) Width WidthConvoy
//   lock      Id Name Geometry(WKT POLYGON) ReferenceLevelBeBu/BoBi NumberOfChambers OperatingTimesId AdministrationId
//   chamber   ParentId(lock) Number Length Width GateWidth SchutLengteVloed/Eb SillDepthBeBu/BoBi(elevation, m, ≤ 0)
//             Geometry(WKT POLYGON) Note
//   radiocallinpoint  ParentId ParentGeoType(bridge|lock|…) VhfChannels[] RadioTraffic Geometry
//   operatingtimes    Id NormalSchedules[{From:"--MM-DD", Mon..Sun:{OperatingTimes:[{FromTime,ToTime,Recommendation?}]}}]
//                     (Recommendation BERP = commercial only, VERZ = on request) HolidaySchedules SignInPeriod Note
//   section   Id Geometry(WKT LINESTRING) StartJunctionId EndJunctionId RouteId RouteKmBegin/End Length(km)
//   maximumdimensions RouteId RouteKmBegin/End GeneralLength/Width/Depth/Height SeaFairing* Pushed* (no CEMT field
//                     exists in v1.4: the CEMT class is DERIVED from the general max dimensions)
//   touristharbour    Id Name Geometry LongStayPlaces ShortStayPlaces SuppliesFuel
//   administration    Id Name Type(RWS HBDR PROV GEM WSCH …)
// Not present in v1.4 (probe answered "Invalid geo type"): fairwaysection (it is `section`), cemt*, notice.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packFis, unpackFis, layoutSpans, deckLine } from '../server/fis.js';

const BASE = 'https://www.vaarweginformatie.nl/wfswms/dataservice/1.4';
export const ENTITIES = ['bridge', 'opening', 'lock', 'chamber', 'radiocallinpoint', 'operatingtimes', 'section', 'maximumdimensions', 'touristharbour', 'administration'];
export const ATTRIBUTION = 'Bridges & locks NL: © Rijkswaterstaat / Vaarweginformatie.nl (CC0)';
const D2R = Math.PI / 180;
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ------------------------------------------------------------------------------------------------ fetch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(u) {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(u); if (r.ok) return await r.json(); console.error('HTTP', r.status, u); } catch (e) { console.error('fetch error', e.message); }
    await sleep(3000 * (i + 1));
  }
  throw new Error('failed: ' + u);
}
export async function fetchAll(entities = ENTITIES, log = console.log) {
  const meta = await getJson(BASE + '/geogeneration');
  const gen = meta.GeoGeneration;
  const raw = { meta: { gen, publication: meta.PublicationDate, fetchedAt: new Date().toISOString() } };
  for (const e of entities) {
    const out = []; let off = 0, total = Infinity;
    while (off < total) {
      await sleep(1000);
      const j = await getJson(`${BASE}/${gen}/${e}?offset=${off}&count=100`);
      total = j.TotalCount; out.push(...(j.Result || [])); off += 100;
    }
    raw[e] = out; log(`${e}: ${out.length}`);
  }
  return raw;
}
export function readRaw(dir) {
  const raw = { meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) };
  for (const e of ENTITIES) { const f = path.join(dir, e + '.json'); raw[e] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; }
  return raw;
}

// ------------------------------------------------------------------------------------------------ geometry
export function parseWkt(s) {
  if (typeof s !== 'string') return null;
  const m = /^\s*(\w+)\s*\((.*)\)\s*$/s.exec(s); if (!m) return null;
  const kind = m[1].toUpperCase();
  const pts = (t) => t.replace(/[()]/g, '').split(',').map((p) => { const [x, y] = p.trim().split(/\s+/).map(Number); return [r5(y), r5(x)]; });
  if (kind === 'POINT') return { kind, pts: pts(m[2]) };
  if (kind === 'LINESTRING') return { kind, pts: pts(m[2]) };
  if (kind === 'POLYGON') return { kind, pts: pts(m[2].split('),')[0]) };
  if (kind === 'MULTILINESTRING') { const parts = m[2].split(/\)\s*,\s*\(/).map(pts); return { kind, pts: parts.flat(), parts }; }
  return null;
}
const mPerLon = (lat) => 111320 * Math.cos(lat * D2R);
export function distM(a, b) { const dy = (a[0] - b[0]) * 110540, dx = (a[1] - b[1]) * mPerLon((a[0] + b[0]) / 2); return Math.hypot(dx, dy); }
function centroid(pts) { let a = 0, b = 0; for (const p of pts) { a += p[0]; b += p[1]; } return [r5(a / pts.length), r5(b / pts.length)]; }
/** Douglas-Peucker in a local metric frame. */
export function simplify(pts, tolM) {
  if (pts.length <= 2) return pts.slice();
  const lat0 = pts[0][0], kx = mPerLon(lat0), ky = 110540;
  const xy = pts.map((p) => [p[1] * kx, p[0] * ky]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(); let best = -1, bi = -1;
    const [ax, ay] = xy[i], [bx, by] = xy[j], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    for (let k = i + 1; k < j; k++) {
      const t = Math.max(0, Math.min(1, ((xy[k][0] - ax) * dx + (xy[k][1] - ay) * dy) / L2));
      const d = Math.hypot(xy[k][0] - ax - t * dx, xy[k][1] - ay - t * dy);
      if (d > best) { best = d; bi = k; }
    }
    if (best > tolM) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
/** Long axis of a polygon (PCA), as two end points [[lat,lon],[lat,lon]] and the extent along / across (m). */
export function longAxis(ring) {
  const c = centroid(ring), kx = mPerLon(c[0]), ky = 110540;
  const xy = ring.map((p) => [(p[1] - c[1]) * kx, (p[0] - c[0]) * ky]);
  let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of xy) { sxx += x * x; syy += y * y; sxy += x * y; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
  let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const [x, y] of xy) { const s = x * ux + y * uy, w = -x * uy + y * ux; lo = Math.min(lo, s); hi = Math.max(hi, s); wlo = Math.min(wlo, w); whi = Math.max(whi, w); }
  const P = (s) => [r5(c[0] + (s * uy) / ky), r5(c[1] + (s * ux) / kx)];
  return { axis: [P(lo), P(hi)], len: hi - lo, wid: whi - wlo };
}

// ------------------------------------------------------------------------------------------------ tables
export const MOV_OF_TYPE = { VST: 'fixed', HEF: 'lift', BC: 'bascule', KLP: 'bascule', RBC: 'bascule', DBC: 'bascule2', OPH: 'draw', DOP: 'draw',
  DR: 'swing', DDR: 'swing', PDR: 'pontoon', PON: 'pontoon', ROL: 'retract', OKW: 'fixed' };
export const DATUM_OF_REF = { NAP: 'NAP', KP: 'KP', MP: 'KP', SP: 'KP', PP: 'KP', BP: 'KP' };
const LOCK_REF = { 'Normaal Amsterdams Peil': 'NAP', Kanaalpeil: 'KP', Meerpeil: 'KP', Stuwpeil: 'KP', Polderpeil: 'KP', Boezempeil: 'KP' };
export const CEMT_DIMS = [ // class, max L, B, T (shared/waterworks.js CEMT) — used to derive the class from FIS max dimensions
  ['VII', 285, 34.2, 4.0], ['VIc', 280, 22.8, 4.0], ['VIb', 195, 22.8, 4.0], ['VIa', 110, 22.8, 4.0], ['Vb', 185, 11.4, 4.0],
  ['Va', 110, 11.4, 3.5], ['IV', 85, 9.5, 2.8], ['III', 80, 8.2, 2.5], ['II', 55, 6.6, 2.5], ['I', 38.5, 5.05, 2.5]];
/** Largest CEMT class whose standard vessel fits the given max dimensions (tolerance 3 % on L/B, 0.3 m on T). */
export function cemtOf(L, B, T) {
  if (!(L > 0) || !(B > 0)) return null;
  for (const [c, l, b, t] of CEMT_DIMS) if (L >= l * 0.97 && B >= b * 0.97 && (!(T > 0) || T >= t - 0.3)) return c;
  return '0';
}
function operatorOf(adm) {
  if (!adm) return null;
  if (adm.Type === 'RWS') return 'RWS';
  if (adm.Type === 'HBDR') return /rotterdam/i.test(adm.Name) ? 'Port of Rotterdam' : 'Port';
  if (adm.Type === 'PROV') return 'Province';
  if (adm.Type === 'GEM') return 'Municipality';
  if (adm.Type === 'WSCH') return 'Water board';
  return 'Other';
}
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const fmt = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
function mergeRanges(rs) {
  const v = rs.map(([a, b]) => [hm(a), b === '00:00' ? 1440 : b === '23:59' ? 1440 : hm(b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of v) { const l = out[out.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else out.push(r.slice()); }
  return out.map(([a, b]) => [fmt(a), b >= 1440 ? '24:00' : fmt(b)]);
}
/** OpHours + blocks + slots from an operatingtimes record, for the schedule valid on `date` (UTC date of the fetch). */
/** One night window from a day's on-request ranges: [22:00–24:00] + [00:00–06:00] → {from 22:00, to 06:00}. */
function nightOf(ranges, noticeMin) {
  const late = ranges.find((r) => r[1] === '24:00'), early = ranges.find((r) => r[0] === '00:00');
  if (late && early && late !== early) return { from: late[0], to: early[1], noticeMin };
  return { from: ranges[0][0], to: ranges[ranges.length - 1][1], noticeMin };
}
export function hoursOf(ot, date = new Date()) {
  if (!ot || !Array.isArray(ot.NormalSchedules) || !ot.NormalSchedules.length) return null;
  const md = `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  const scheds = ot.NormalSchedules.slice().sort((a, b) => String(a.From).localeCompare(String(b.From)));
  let s = scheds[scheds.length - 1];
  for (const x of scheds) if (String(x.From).slice(2) <= md) s = x;
  const week = [], blocks = [], req = [];
  DAYS.forEach((d, i) => {
    const ts = (s[d] && s[d].OperatingTimes) || [];
    const on = [], small = [], verz = [];
    for (const t of ts) {
      if (t.Recommendation === 'VERZ') verz.push([t.FromTime, t.ToTime]);
      else { on.push([t.FromTime, t.ToTime]); if (t.Recommendation === 'BERP') small.push([t.FromTime, t.ToTime]); }
    }
    week.push(mergeRanges(on));
    for (const [a, b] of mergeRanges(small)) blocks.push({ days: [i + 1], from: a, to: b, why: 'commercial traffic only', only: 'small' });
    req.push(mergeRanges(verz));
  });
  // collapse identical per-day blocks
  const bmap = new Map();
  for (const b of blocks) { const k = `${b.from}-${b.to}-${b.only}`; if (bmap.has(k)) bmap.get(k).days.push(b.days[0]); else bmap.set(k, { ...b }); }
  const notice = Number.isFinite(ot.SignInPeriod) && ot.SignInPeriod > 0 ? Math.min(24 * 60, ot.SignInPeriod * 60) : 60;
  const reqAny = req.find((r) => r.length);
  const note = [s.Note, ot.Note].filter(Boolean).join(' ');
  let slots = null;
  if (/kwart voor en kwart over/i.test(note)) slots = { every: 30, at: 15 };
  else if (/(hele en halve uur|heel en half uur)/i.test(note)) slots = { every: 30, at: 0 };
  return {
    hours: { tz: 'Europe/Amsterdam', week, holidays: 'sunday', onRequestNight: reqAny ? nightOf(reqAny, notice) : null },
    blocks: [...bmap.values()], slots, note: note.slice(0, 300) || null,
  };
}

// Hand overrides (game rules or checked facts that FIS does not carry), keyed by FIS id. Kept tiny and documented.
export const OVERRIDES = {
  'lock:4199': { // Rozenburgsesluis: double-acting, Port of Rotterdam 24/7; side levels per doc §4.8.1 (game rule)
    doubleActing: true,
    sides: [{ name: 'Calandkanaal', level: { kind: 'tidal' } }, { name: 'Hartelkanaal', level: { kind: 'damped', of: 'tidal', k: 0.6, lagMin: 40 } }],
  },
};

// ------------------------------------------------------------------------------------------------ normalise
function projAlong(line, p) { // metres along a 2-point line of the projection of p
  const [a, b] = line, kx = mPerLon(a[0]), ky = 110540;
  const dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * ky, L = Math.hypot(dx, dy) || 1;
  return ((p[1] - a[1]) * kx * dx + (p[0] - a[0]) * ky * dy) / L;
}
function bearingOfSection(sec, p) { // local bearing (deg) of the section polyline nearest p
  let best = Infinity, brg = 0;
  for (let i = 0; i + 1 < sec.length; i++) {
    const a = sec[i], b = sec[i + 1];
    const d = distM(p, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    if (d < best) { best = d; brg = Math.atan2((b[1] - a[1]) * mPerLon(a[0]), (b[0] - a[0]) * 110540) / D2R; }
  }
  return brg;
}

export function normalise(raw, { date = new Date(), log = () => {} } = {}) {
  const by = (arr, k) => { const m = new Map(); for (const r of arr || []) { const v = r[k]; if (v == null) continue; if (!m.has(v)) m.set(v, []); m.get(v).push(r); } return m; };
  const adm = new Map((raw.administration || []).map((a) => [a.Id, a]));
  const ots = new Map((raw.operatingtimes || []).map((o) => [o.Id, o]));
  const openings = by(raw.opening, 'ParentId'), chambers = by(raw.chamber, 'ParentId');
  const rcp = by(raw.radiocallinpoint, 'ParentId');
  const vhfOf = (id) => { for (const r of rcp.get(id) || []) for (const c of r.VhfChannels || []) { const n = Number(c); if (n > 0 && n < 100) return n; } return null; };

  // sections (graph edges) --------------------------------------------------------------------------
  const md = by(raw.maximumdimensions, 'RouteId');
  const secGeom = new Map();
  const sections = [];
  for (const s of raw.section || []) {
    const g = parseWkt(s.Geometry); if (!g || g.pts.length < 2) continue;
    secGeom.set(s.Id, g.pts);
    const lo = Math.min(s.RouteKmBegin ?? 0, s.RouteKmEnd ?? 0), hi = Math.max(s.RouteKmBegin ?? 0, s.RouteKmEnd ?? 0);
    let lim = null;
    for (const m of md.get(s.RouteId) || []) {
      const a = Math.min(m.RouteKmBegin, m.RouteKmEnd), b = Math.max(m.RouteKmBegin, m.RouteKmEnd);
      if (b < lo || a > hi) continue;
      const L = num(m.SeaFairingLength) ?? num(m.GeneralLength), B = num(m.SeaFairingWidth) ?? num(m.GeneralWidth), T = num(m.SeaFairingDepth) ?? num(m.GeneralDepth), H = num(m.SeaFairingHeight) ?? num(m.GeneralHeight);
      const c = { L, B, T, H, cemt: cemtOf(num(m.GeneralLength), num(m.GeneralWidth), num(m.GeneralDepth)) };
      if (!lim) lim = c; else for (const k of ['L', 'B', 'T', 'H']) if (c[k] != null) lim[k] = lim[k] == null ? c[k] : Math.min(lim[k], c[k]);
      if (!lim.cemt) lim.cemt = c.cemt;
    }
    const pts = simplify(g.pts, 20);
    sections.push({ id: s.Id, j: [s.StartJunctionId ?? null, s.EndJunctionId ?? null], pts, len: Math.round((s.Length ?? 0) * 1000) || null, route: s.RouteId,
      ...(lim ? { lim: Object.fromEntries(Object.entries(lim).filter(([, v]) => v != null)) } : {}) });
  }

  // bridges --------------------------------------------------------------------------------------------
  const bridges = [], lockBridges = [];
  let skipped = 0;
  for (const b of raw.bridge || []) {
    const g = parseWkt(b.Geometry); const ops = (openings.get(b.Id) || []).slice().sort((x, y) => x.Number - y.Number);
    if (!g || !ops.length) { skipped++; continue; }
    const p = g.pts[0];
    const datum = DATUM_OF_REF[b.Referencelevel] || (b.MhwReferenceLevel === 'RIVER' ? 'NAP' : 'KP');
    // synthetic deck line across the fairway (OSM/OFM replaces it at the join, §3.5)
    const sec = secGeom.get(b.FairwaySectionId);
    const across = (sec ? bearingOfSection(sec, p) : (num(b.Rotation) ?? 0)) + 90;
    const totalW = ops.reduce((s, o) => s + (num(o.Width) > 0 ? o.Width : 6), 0);
    const half = totalW / 2 + 20, kx = mPerLon(p[0]);
    const off = (d) => [r5(p[0] + (d * Math.cos(across * D2R)) / 110540), r5(p[1] + (d * Math.sin(across * D2R)) / kx)];
    const line = [off(-half), off(half)];
    let anyEst = false;
    const spans = ops.map((o, i) => {
      const mov = MOV_OF_TYPE[o.Type] || 'fixed';
      const w = num(o.Width) > 0 ? o.Width : num(o.WidthConvoy) > 0 ? o.WidthConvoy : 6;
      const op = parseWkt(o.Geometry)?.pts[0] || p;
      let mid = projAlong(line, op);
      if (!(mid > w / 2 && mid < 2 * half - w / 2)) mid = half; // opening point off the line: centre it
      let clr = num(o.HeightClosed);
      if (o.Type === 'OKW') clr = num(o.HeightOpened) ?? clr;
      if (clr == null) { clr = mov === 'fixed' ? 2.5 : 1.5; anyEst = true; }
      let clrO = null;
      if (mov !== 'fixed') clrO = num(o.HeightOpened) ?? (mov === 'lift' ? (anyEst = true, clr + 25) : 999);
      return { id: i, n: o.Number, a: r2(mid - w / 2), b: r2(mid + w / 2), mov, clr: r2(clr), clrO: clrO == null ? null : r2(clrO), w: r2(w), hinge: null, pivot: mov === 'swing' ? 0.5 : null, rec: 0, fis: o.Id };
    });
    const Lr = layoutSpans(spans, 2 * half);
    if (Lr !== 2 * half) { const l2 = deckLine(p, across, Lr / 2); line[0] = l2[0]; line[1] = l2[1]; }
    const movSpans = spans.filter((s) => s.mov !== 'fixed');
    const recSpan = (movSpans.length ? movSpans : spans).reduce((m, s) => (s.w > m.w ? s : m));
    recSpan.rec = 1;
    const vhf = vhfOf(b.Id);
    const ot = hoursOf(ots.get(b.OperatingTimesId), date);
    const obj = {
      id: 'fis:' + b.Id, name: b.Name, kind: 'road', src: 'fis', e: anyEst ? 2 : 0, p, line, lineSrc: 'synthetic', deckW: 12, structure: 'girder',
      spans, datum, kp: null, mhw: num(b.MhwOffset),
      vhf, call: movSpans.length ? (vhf ? 'vhf' : b.PhoneNumber ? 'phone' : 'button') : 'none', callName: b.Name.replace(/^Brug over /, ''),
      hours: movSpans.length ? (ot ? ot.hours : null) : null, hoursE: movSpans.length && !ot ? 2 : 0,
      blocks: ot ? ot.blocks : [], slots: ot ? ot.slots : null, remote: !!b.IsRemoteControlled,
      lockId: null, pairedWith: null, head: null, fee: 0, notes: ot && ot.note ? [ot.note] : [], operator: operatorOf(adm.get(b.AdministrationId)),
      section: b.FairwaySectionId ?? null, rel: b.RelatedBuildingComplexName || null,
    };
    bridges.push(obj);
    if (obj.rel) lockBridges.push(obj);
  }
  log(`bridges ${bridges.length} (skipped ${skipped} without openings)`);

  // locks ----------------------------------------------------------------------------------------------
  const locks = [];
  for (const l of raw.lock || []) {
    const g = parseWkt(l.Geometry); const chs = (chambers.get(l.Id) || []).slice().sort((x, y) => x.Number - y.Number);
    if (!g) continue;
    const ring = g.kind === 'POLYGON' ? simplify(g.pts, 2) : null;
    const cList = chs.map((c, i) => {
      const cg = parseWkt(c.Geometry);
      const ax = cg && cg.kind === 'POLYGON' ? longAxis(cg.pts) : ring ? longAxis(ring) : null;
      const len = num(c.SchutLengteVloed) ?? num(c.SchutLengteEb) ?? num(c.Length) ?? (ax ? Math.round(ax.len - 10) : null);
      const wid = num(c.Width) ?? num(c.GateWidth) ?? (ax ? Math.round(ax.wid - 1) : null);
      if (!(len > 0) || !(wid > 0)) return null;
      const z0 = num(c.SillDepthBeBu) ?? num(c.SillDepthInner), z1 = num(c.SillDepthBoBi) ?? num(c.SillDepthInner);
      const note = String(c.Note || '');
      const gate = /rold/i.test(note) ? 'rolling' : /hefd/i.test(note) ? 'lift' : /segment|sector/i.test(note) ? 'sector' : 'mitre';
      return {
        id: String.fromCharCode(65 + i), fis: c.Id, kind: wid < 7 || len < 40 ? 'small' : 'both', len, wid,
        sillDn: z0 != null ? r2(-z0) : null, sillUp: z1 != null ? r2(-z1) : null, sillE: z0 == null || z1 == null ? 2 : 0,
        axis: ax ? ax.axis : null, gates: [{ head: 0, type: gate, at: 0 }, { head: 1, type: gate, at: len }],
        culvert: null, bollards: { step: 15, floating: false, levels: 3 }, waiting: [], note: note.slice(0, 160) || null,
      };
    }).filter(Boolean);
    if (!cList.length && num(l.Length) && num(l.Width)) cList.push({ id: 'A', kind: 'both', len: l.Length, wid: l.Width, sillDn: null, sillUp: null, sillE: 2, axis: ring ? longAxis(ring).axis : null, gates: [{ head: 0, type: 'mitre', at: 0 }, { head: 1, type: 'mitre', at: l.Length }], culvert: null, bollards: { step: 15, floating: false, levels: 3 }, waiting: [] });
    if (!cList.length) continue;
    const lv = (ref) => (LOCK_REF[ref] === 'NAP' ? { kind: 'tidal' } : { kind: 'kp', h: 0 });
    const ot = hoursOf(ots.get(l.OperatingTimesId), date);
    const obj = {
      id: 'fis:' + l.Id, name: l.Name, callName: l.Name, src: 'fis', e: 0, p: ring ? centroid(ring) : g.pts[0], ring,
      chambers: cList, sides: [{ name: 'outer', level: lv(l.ReferenceLevelBeBu) }, { name: 'inner', level: lv(l.ReferenceLevelBoBi) }],
      doubleActing: false, vhf: vhfOf(l.Id), call: vhfOf(l.Id) ? 'vhf' : l.PhoneNumber ? 'phone' : 'button',
      hours: ot ? ot.hours : null, blocks: ot ? ot.blocks : [], fee: null, bridges: [], notices: [], operator: operatorOf(adm.get(l.AdministrationId)),
      remote: !!l.IsRemoteControlled, section: l.FairwaySectionId ?? null, rel: l.RelatedBuildingComplexName || l.Name,
    };
    const ov = OVERRIDES['lock:' + l.Id]; if (ov) Object.assign(obj, ov);
    locks.push(obj);
  }
  // lock-head bridges (§4.8.7): same building complex; head from the name (buitenhoofd = 0, binnenhoofd = 1)
  const lockByRel = new Map(locks.map((l) => [l.rel, l]));
  for (const b of lockBridges) {
    const l = lockByRel.get(b.rel); if (!l || distM(b.p, l.p) > 1500) continue;
    b.lockId = l.id; b.head = /binnenhoofd|bovenhoofd/i.test(b.name) ? 1 : /buitenhoofd|benedenhoofd/i.test(b.name) ? 0 : null; l.bridges.push(b.id);
  }
  for (const l of locks) {
    const mov = l.bridges.map((id) => bridges.find((b) => b.id === id)).filter((b) => b.spans.some((s) => s.mov !== 'fixed'));
    if (mov.length === 2) { mov[0].pairedWith = mov[1].id; mov[1].pairedWith = mov[0].id; }
  }
  log(`locks ${locks.length}`);

  const harbours = (raw.touristharbour || []).map((h) => { const g = parseWkt(h.Geometry); return g ? { id: 'fis:' + h.Id, name: h.Name, p: g.pts[0], long: h.LongStayPlaces ?? null, short: h.ShortStayPlaces ?? null, fuel: !!h.SuppliesFuel } : null; }).filter(Boolean);

  return {
    v: 1, geogeneration: raw.meta.gen, publication: raw.meta.publication || null, fetchedAt: raw.meta.fetchedAt, attribution: ATTRIBUTION,
    source: BASE, licence: 'CC0 1.0', bridges, locks, sections, harbours,
  };
}

/** The 3 probe objects, raw and normalised (§3.4). */
export function probe(raw, data) {
  const pick = (re) => raw.bridge.filter((b) => re.test(b.Name)).concat(raw.lock.filter((l) => re.test(l.Name)));
  const out = [];
  for (const re of [/^Botlekbrug$/, /^Calandbrug Rozenburg$/, /^Rozenburgsesluis$/, /Rozenburgsesluis/]) {
    for (const r of pick(re)) {
      const kids = [...raw.opening, ...raw.chamber, ...raw.radiocallinpoint].filter((o) => o.ParentId === r.Id).map((o) => ({ ...o, Geometry: String(o.Geometry).slice(0, 60) }));
      const n = [...data.bridges, ...data.locks].find((o) => o.id === 'fis:' + r.Id) || null;
      out.push({ raw: { ...r, Geometry: String(r.Geometry).slice(0, 80) }, children: kids, normalised: n });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ CLI
async function main() {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = opt('--out') || path.join(here, '..', 'server', 'waterworks', 'nl-fis.json.gz');
  const fromRaw = opt('--from-raw');
  let raw;
  if (fromRaw) raw = readRaw(fromRaw);
  else {
    raw = await fetchAll(ENTITIES);
    const keep = opt('--raw');
    if (keep) { fs.mkdirSync(keep, { recursive: true }); fs.writeFileSync(path.join(keep, 'meta.json'), JSON.stringify(raw.meta)); for (const e of ENTITIES) fs.writeFileSync(path.join(keep, e + '.json'), JSON.stringify(raw[e])); }
  }
  const data = normalise(raw, { log: console.log });
  if (args.includes('--probe')) { console.log(JSON.stringify(probe(raw, data), null, 1)); return; }
  const packed = packFis(data);
  unpackFis(packed); // round-trip sanity
  const buf = zlib.gzipSync(JSON.stringify(packed), { level: 9 });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out}: ${(buf.length / 1024).toFixed(0)} KB gz, ${data.bridges.length} bridges, ${data.locks.length} locks, ${data.sections.length} sections, ${data.harbours.length} harbours, geogeneration ${data.geogeneration}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
