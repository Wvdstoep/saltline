// World-tile upstream sources (docs/WORLD-DETAIL-STREAMING.md §2.3, §4.2, §4.3): OpenFreeMap vector tiles (base
// geometry, version pinned in data/world/pin.json), AWS Terrarium PNG z9 (open-sea depth) and an Overpass "maritime
// overlay" per z12 square (quays, breakwaters, cranes, locks, lights, seamarks). Network only: the disk cache lives in
// server/worldtiles.js. Nothing here throws to callers; every fetch resolves to a result object.
//
// Politeness: descriptive User-Agent; OpenFreeMap ≤ SALTLINE_WT_CONC (4) in flight, ≤ 8 req/s, ≤ 40 000/day;
// Terrarium ≤ 2 in flight; Overpass 1 in flight, ≥ 3 s apart, ≤ 1 500/day, Retry-After honoured. Circuit breaker per
// host (5 failures / 429 / 5xx in a row → open 60 s, doubling to 15 min) and a 10-minute negative cache per tile.
// SALTLINE_WT_OFFLINE=1 or NODE_TEST_CONTEXT disables every upstream (tests inject `fetchImpl` and `offline: false`).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from './paths.js';
import { tileFToLatLon } from '../shared/wtformat.js';

export const UA = 'Saltline/0.8 (+https://saltline.mavicpro-fan.my-app.engineer; world tiles)';
export const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const ofmUrl = (ver, z, x, y) => `https://tiles.openfreemap.org/planet/${ver}/${z}/${x}/${y}.pbf`;
export const terrariumUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const DAY_MS = 24 * 3600e3;
const MAX_TILE_BYTES = 8 * 1024 * 1024;

/** The version segment of an OpenFreeMap tile URL template (".../planet/<ver>/{z}/{x}/{y}.pbf"), or null. */
export function versionFromTemplate(t) { const m = /\/planet\/([A-Za-z0-9_.-]+)\/\{z\}/.exec(String(t || '')); return m ? m[1] : null; }

// ------------------------------------------------------------------------------------------------ Terrarium PNG
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
/** Minimal PNG decoder (8-bit RGB / RGBA, not interlaced) → { w, h, ch, px }. Null on anything else. */
export function decodePNG(buf) {
  try {
    const b = Buffer.from(buf.buffer ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : buf);
    if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
    let o = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0;
    const idat = [];
    while (o + 8 <= b.length) {
      const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
      if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; inter = d[12]; }
      else if (type === 'IDAT') idat.push(d);
      else if (type === 'IEND') break;
      o += 12 + len;
    }
    if (depth !== 8 || inter !== 0 || (ctype !== 2 && ctype !== 6) || !w || !h) return null;
    const ch = ctype === 6 ? 4 : 3, stride = w * ch;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (raw.length < h * (stride + 1)) return null;
    const px = new Uint8Array(w * h * ch);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
      for (let i = 0; i < stride; i++) {
        const x = raw[src + i], a = i >= ch ? px[dst + i - ch] : 0, up = y ? px[dst - stride + i] : 0, c = y && i >= ch ? px[dst - stride + i - ch] : 0;
        px[dst + i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + up : f === 3 ? x + ((a + up) >> 1) : x + paeth(a, up, c)) & 255;
      }
    }
    return { w, h, ch, px };
  } catch { return null; }
}
/** Terrarium PNG → Int16Array (256², decimetres, row 0 = north) or null. elev = R·256 + G + B/256 − 32768. */
export function decodeTerrarium(buf) {
  const img = decodePNG(buf);
  if (!img || img.w !== 256 || img.h !== 256) return null;
  const out = new Int16Array(256 * 256);
  for (let i = 0; i < out.length; i++) {
    const o = i * img.ch, m = img.px[o] * 256 + img.px[o + 1] + img.px[o + 2] / 256 - 32768;
    out[i] = Math.max(-32000, Math.min(32000, Math.round(m * 10)));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ Overpass overlay
/** Bounding box [s, w, n, e] of a z12 square. */
export function z12Bbox(x, y) { const nw = tileFToLatLon(12, x, y), se = tileFToLatLon(12, x + 1, y + 1); return [se.lat, nw.lon, nw.lat, se.lon]; }
const SEAMARK_TYPES = 'fairway|dredged_area|depth_area|light_major|light_minor|light_vessel|light_float|beacon_lateral|beacon_cardinal|beacon_isolated_danger|beacon_safe_water|beacon_special_purpose|buoy_lateral|buoy_cardinal|buoy_isolated_danger|buoy_safe_water|buoy_special_purpose|bridge|harbour';
/** The maritime overlay query for one z12 square (≈ 6–10 km). */
export function overlayQuery(x, y) {
  const b = z12Bbox(x, y).map((v) => v.toFixed(6)).join(',');
  return `[out:json][timeout:60][maxsize:67108864];(` +
    `way["man_made"~"^(quay|breakwater|groyne|pier|pontoon)$"](${b});way["floating"="yes"](${b});` +
    `way["waterway"="lock"](${b});way["lock"="yes"]["waterway"](${b});node["waterway"="lock_gate"](${b});way["waterway"="lock_gate"](${b});` +
    `node["man_made"~"^(crane|lighthouse|storage_tank|silo)$"](${b});way["man_made"~"^(crane|storage_tank|silo)$"](${b});` +
    `nwr["seamark:type"~"^(${SEAMARK_TYPES})$"](${b});` +
    `);out tags geom qt;`;
}
const KEEP_TAGS = /^(man_made|floating|waterway|lock|name|height|width|diameter|crane:type|seamark:type|seamark:.*(colour|character|period|category|minimum_depth|clearance_height|height|range)|depth|maxdraught|maxheight|bridge:movable|ele)$/;
function keepTags(t) { const o = {}; for (const [k, v] of Object.entries(t || {})) if (KEEP_TAGS.test(k)) o[k] = String(v).slice(0, 60); return o; }
function overlayKind(t) {
  const mm = t.man_made, st = t['seamark:type'] || '';
  if (t.waterway === 'lock_gate') return 'lock_gate';
  if (t.waterway === 'lock' || t.lock === 'yes') return 'lock';
  if (mm === 'pontoon' || t.floating === 'yes') return 'pontoon';
  if (mm === 'quay') return 'quay';
  if (mm === 'breakwater' || mm === 'groyne') return 'breakwater';
  if (mm === 'pier') return 'pier';
  if (mm === 'crane') return 'crane';
  if (mm === 'storage_tank' || mm === 'silo') return 'tank';
  if (mm === 'lighthouse') return 'lighthouse';
  if (st === 'fairway') return 'fairway';
  if (st === 'dredged_area') return 'dredged';
  if (st === 'depth_area') return 'depth';
  if (st.startsWith('light')) return 'light';
  if (st.startsWith('beacon')) return 'beacon';
  if (st.startsWith('buoy')) return 'buoy';
  if (st === 'bridge') return 'bridge';
  return null;
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
/**
 * Overpass JSON → compact overlay `{ v: 1, date, x, y, f: [{ k, t, g: [lat, lon, …], c: 0|1 }] }` (c = closed ring;
 * multipolygon relations contribute one entry per outer ring). Deterministic order (by kind, then OSM id).
 */
export function compactOverlay(json, x, y, date) {
  const f = [];
  for (const el of json?.elements || []) {
    const t = el.tags || {}, k = overlayKind(t);
    if (!k) continue;
    const tags = keepTags(t);
    if (el.type === 'node' && Number.isFinite(el.lat)) f.push({ id: `n${el.id}`, k, t: tags, g: [r6(el.lat), r6(el.lon)], c: 0 });
    else if (el.type === 'way' && Array.isArray(el.geometry)) {
      const g = []; for (const p of el.geometry) if (p) g.push(r6(p.lat), r6(p.lon));
      if (g.length < 2) continue;
      const closed = g.length >= 8 && g[0] === g[g.length - 2] && g[1] === g[g.length - 1];
      f.push({ id: `w${el.id}`, k, t: tags, g: closed ? g.slice(0, -2) : g, c: closed ? 1 : 0 });
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      let n = 0;
      for (const m of el.members) {
        if (m.type !== 'way' || m.role !== 'outer' || !Array.isArray(m.geometry)) continue;
        const g = []; for (const p of m.geometry) if (p) g.push(r6(p.lat), r6(p.lon));
        if (g.length >= 6) f.push({ id: `r${el.id}.${n++}`, k, t: tags, g, c: 1 });
      }
    }
  }
  f.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { v: 1, date, x, y, f };
}

// ------------------------------------------------------------------------------------------------ service
/**
 * opts (all optional): fetchImpl, dataDir (DATA_DIR; pin.json lives in <dataDir>/world), offline, log, now,
 * ofmConc 4, ofmPerSec 8, ofmDaily 40000, bathyConc 2, overpassGapMs 3000, overpassDaily 1500, timeoutMs 15 s,
 * overpassTimeoutMs 60 s, breakerThreshold 5, breakerMs 60 s, breakerMaxMs 15 min, negativeTtlMs 10 min, pinVersion.
 */
export function createSources(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const dataDir = opts.dataDir || DATA_DIR;
  const offline = opts.offline ?? (process.env.SALTLINE_WT_OFFLINE === '1' || !!process.env.NODE_TEST_CONTEXT);
  const now = opts.now || Date.now;
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), '[wt]', ...a));
  const envConc = Number(process.env.SALTLINE_WT_CONC);
  const ofmConc = opts.ofmConc ?? (Number.isFinite(envConc) ? envConc : 4);
  const ofmPerSec = opts.ofmPerSec ?? 8, ofmDaily = opts.ofmDaily ?? 40000;
  const bathyConc = opts.bathyConc ?? 2;
  const overpassGapMs = opts.overpassGapMs ?? 3000, overpassDaily = opts.overpassDaily ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 15000, overpassTimeoutMs = opts.overpassTimeoutMs ?? 60000;
  const breakerThreshold = opts.breakerThreshold ?? 5, breakerMs = opts.breakerMs ?? 60e3, breakerMaxMs = opts.breakerMaxMs ?? 15 * 60e3;
  const negativeTtlMs = opts.negativeTtlMs ?? 10 * 60e3;
  const pinFile = path.join(dataDir, 'world', 'pin.json');

  const st = { ofm: 0, ofmOk: 0, ofm404: 0, bathy: 0, bathyOk: 0, overpass: 0, overpassOk: 0, failed: 0, repins: 0, negativeHits: 0 };
  const day = { start: now(), ofm: 0, overpass: 0 };
  const negative = new Map();
  const breakers = new Map();      // host → { fails, openUntil, openMs, logged }
  const slots = new Map();         // host → { active, max, waiters: [] }
  let ofmWindow = [];              // timestamps of the last second's OpenFreeMap requests
  let overpassLast = 0, overpassRetryAt = 0, overpassEp = 0;
  let pin = null, pinning = null, lastRepinCheck = 0;

  try { const j = JSON.parse(fs.readFileSync(pinFile, 'utf8')); if (j && typeof j.ofm === 'string') pin = j; } catch { /* no pin yet */ }
  if (opts.pinVersion) pin = { ofm: opts.pinVersion, pinnedAt: now() };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));   // not unref'd: a CLI run must not exit while a request waits for its slot
  function rollDay() { if (now() - day.start >= DAY_MS) { day.start = now(); day.ofm = 0; day.overpass = 0; } }
  function breaker(host) { let b = breakers.get(host); if (!b) { b = { fails: 0, openUntil: 0, openMs: breakerMs, logged: 0 }; breakers.set(host, b); } return b; }
  const breakerOpen = (host) => breaker(host).openUntil > now();
  function breakerResult(host, ok) {
    const b = breaker(host);
    if (ok) { b.fails = 0; b.openMs = breakerMs; return; }
    b.fails++; st.failed++;
    if (b.fails >= breakerThreshold && b.openUntil <= now()) {
      b.openUntil = now() + b.openMs;
      if (now() - b.logged > 10 * 60e3) { b.logged = now(); try { log(`${host} unreachable — pausing for ${Math.round(b.openMs / 1000)} s`); } catch { /* never */ } }
      b.openMs = Math.min(breakerMaxMs, b.openMs * 2);
      b.fails = 0;
    }
  }
  function negHit(key) { const u = negative.get(key); if (u == null) return false; if (now() < u) { st.negativeHits++; return true; } negative.delete(key); return false; }
  function setNeg(key) { negative.set(key, now() + negativeTtlMs); if (negative.size > 50000) { const t = now(); for (const [k, u] of negative) if (u <= t) negative.delete(k); } }
  function slot(host, max) { let s = slots.get(host); if (!s) { s = { active: 0, max, waiters: [] }; slots.set(host, s); } return s; }
  function acquire(host, max) { const s = slot(host, max); if (s.active < s.max) { s.active++; return Promise.resolve(); } return new Promise((r) => s.waiters.push(r)); }
  function release(host) { const s = slots.get(host); const n = s.waiters.shift(); if (n) n(); else s.active--; }

  async function http(url, init, ms) {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
    const res = await fetchImpl(url, { ...init, headers: { 'User-Agent': UA, ...(init?.headers || {}) }, signal, redirect: 'follow' });
    const status = Number(res?.status) || 0;
    let buf = null;
    try { buf = new Uint8Array(await res.arrayBuffer()); } catch { buf = null; }
    const ra = res?.headers?.get ? Number(res.headers.get('retry-after')) : NaN;
    return { status, buf, retryAfter: Number.isFinite(ra) ? ra : null };
  }

  /** Read the TileJSON and return the newest version (null when unreachable). */
  async function latestVersion() {
    if (offline || typeof fetchImpl !== 'function' || breakerOpen('ofm')) return null;
    try {
      const r = await http(OFM_TILEJSON, { headers: { Accept: 'application/json' } }, timeoutMs);
      if (r.status !== 200 || !r.buf) { breakerResult('ofm', r.status === 404); return null; }
      breakerResult('ofm', true);
      const j = JSON.parse(new TextDecoder().decode(r.buf));
      return versionFromTemplate(j?.tiles?.[0]);
    } catch { breakerResult('ofm', false); return null; }
  }
  function writePin(ver, reason) {
    pin = { ofm: ver, pinnedAt: now(), reason };
    try { fs.mkdirSync(path.dirname(pinFile), { recursive: true }); const tmp = `${pinFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(pin)); fs.renameSync(tmp, pinFile); } catch (e) { try { log('pin write failed', e.message); } catch { /* never */ } }
    return pin;
  }
  /** The pinned OpenFreeMap version, pinning the current one on first use. */
  async function ensurePin() {
    if (pin) return pin.ofm;
    if (!pinning) pinning = latestVersion().then((v) => (v ? writePin(v, 'first').ofm : null)).finally(() => { pinning = null; });
    return pinning;
  }
  /** Re-pin to the newest version (operator command or the pinned version disappeared). */
  async function repin(reason = 'operator') {
    const v = await latestVersion();
    if (!v) return null;
    if (pin && pin.ofm === v) return pin.ofm;
    st.repins++;
    try { log(`re-pinning OpenFreeMap ${pin ? pin.ofm : '-'} → ${v} (${reason})`); } catch { /* never */ }
    return writePin(v, reason).ofm;
  }

  async function ofmSlot() {
    await acquire('ofm', Math.max(1, ofmConc));
    for (;;) {   // ≤ ofmPerSec requests in any 1 s window
      const t = now(); ofmWindow = ofmWindow.filter((x) => t - x < 1000);
      if (ofmWindow.length < ofmPerSec) { ofmWindow.push(t); return; }
      await sleep(Math.max(5, 1000 - (t - ofmWindow[0])));
    }
  }

  /**
   * Base vector tile. Resolves { ok: true, buf (MVT bytes, maybe gzip'd), src: 'ofm:<ver>' } or
   * { ok: false, reason: 'offline'|'breaker'|'negative'|'quota'|'nopin'|'missing'|'error' }.
   */
  async function fetchBase(z, x, y) {
    const key = `b${z}/${x}/${y}`;
    try {
      if (offline || typeof fetchImpl !== 'function' || ofmConc <= 0) return { ok: false, reason: 'offline' };
      if (negHit(key)) return { ok: false, reason: 'negative' };
      if (breakerOpen('ofm')) return { ok: false, reason: 'breaker' };
      rollDay();
      if (day.ofm >= ofmDaily) return { ok: false, reason: 'quota' };
      const ver = await ensurePin();
      if (!ver) { setNeg(key); return { ok: false, reason: 'nopin' }; }
      for (let attempt = 0; attempt < 2; attempt++) {
        const v = pin ? pin.ofm : ver;
        await ofmSlot();
        let r;
        try { st.ofm++; day.ofm++; r = await http(ofmUrl(v, z, x, y), { headers: { Accept: 'application/x-protobuf,*/*' } }, timeoutMs); }
        catch { breakerResult('ofm', false); setNeg(key); return { ok: false, reason: 'error' }; }
        finally { release('ofm'); }
        if (r.status === 200 || r.status === 204) {
          breakerResult('ofm', true);
          const buf = r.buf || new Uint8Array(0);
          if (buf.length > MAX_TILE_BYTES) { setNeg(key); return { ok: false, reason: 'error' }; }
          st.ofmOk++;
          return { ok: true, buf, src: `ofm:${v}` };
        }
        if (r.status === 404 || r.status === 410) {
          breakerResult('ofm', true); st.ofm404++;
          // the pinned version may have been deleted upstream: check the TileJSON (≤ once per 10 min) and retry once
          if (attempt === 0 && now() - lastRepinCheck > 10 * 60e3) {
            lastRepinCheck = now();
            const nv = await latestVersion();
            if (nv && pin && nv !== pin.ofm) { st.repins++; try { log(`OpenFreeMap ${pin.ofm} gone (404) → re-pin ${nv}`); } catch { /* never */ } writePin(nv, 'upstream-404'); continue; }
          }
          setNeg(key); return { ok: false, reason: 'missing' };
        }
        breakerResult('ofm', !(r.status === 429 || r.status >= 500 || r.status === 0 || r.status === 403));
        setNeg(key); return { ok: false, reason: 'error' };
      }
      setNeg(key); return { ok: false, reason: 'missing' };
    } catch { return { ok: false, reason: 'error' }; }
  }

  /** Terrarium z9 tile → { ok: true, dm: Int16Array(256²) } | { ok: false, reason }. */
  async function fetchBathy(x9, y9) {
    const key = `t${x9}/${y9}`;
    try {
      if (offline || typeof fetchImpl !== 'function') return { ok: false, reason: 'offline' };
      if (negHit(key)) return { ok: false, reason: 'negative' };
      if (breakerOpen('terrarium')) return { ok: false, reason: 'breaker' };
      await acquire('terrarium', bathyConc);
      let r;
      try { st.bathy++; r = await http(terrariumUrl(9, x9, y9), { headers: { Accept: 'image/png' } }, timeoutMs); }
      catch { breakerResult('terrarium', false); setNeg(key); return { ok: false, reason: 'error' }; }
      finally { release('terrarium'); }
      if (r.status !== 200 || !r.buf) { breakerResult('terrarium', !(r.status === 429 || r.status >= 500 || r.status === 0)); setNeg(key); return { ok: false, reason: r.status === 404 ? 'missing' : 'error' }; }
      breakerResult('terrarium', true);
      const dm = decodeTerrarium(r.buf);
      if (!dm) { setNeg(key); return { ok: false, reason: 'error' }; }
      st.bathyOk++;
      return { ok: true, dm };
    } catch { return { ok: false, reason: 'error' }; }
  }

  /** Overpass overlay of one z12 square → { ok: true, overlay } | { ok: false, reason }. */
  async function fetchOverlay(x12, y12) {
    const key = `o${x12}/${y12}`;
    try {
      if (offline || typeof fetchImpl !== 'function') return { ok: false, reason: 'offline' };
      if (negHit(key)) return { ok: false, reason: 'negative' };
      if (breakerOpen('overpass')) return { ok: false, reason: 'breaker' };
      rollDay();
      if (day.overpass >= overpassDaily) return { ok: false, reason: 'quota' };
      await acquire('overpass', 1);
      try {
        const wait = Math.max(overpassLast + overpassGapMs, overpassRetryAt) - now();
        if (wait > 0) await sleep(wait);
        overpassLast = now(); st.overpass++; day.overpass++;
        const url = OVERPASS_URLS[overpassEp % OVERPASS_URLS.length];
        let r;
        try { r = await http(url, { method: 'POST', body: 'data=' + encodeURIComponent(overlayQuery(x12, y12)), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }, overpassTimeoutMs); }
        catch { breakerResult('overpass', false); overpassEp++; setNeg(key); return { ok: false, reason: 'error' }; }
        overpassLast = now();
        if (r.status === 429 || r.status === 504) { overpassRetryAt = now() + 1000 * Math.min(300, r.retryAfter ?? 30); }
        if (r.status !== 200 || !r.buf) { breakerResult('overpass', false); overpassEp++; setNeg(key); return { ok: false, reason: 'error' }; }
        let json;
        try { json = JSON.parse(new TextDecoder().decode(r.buf)); } catch { breakerResult('overpass', false); setNeg(key); return { ok: false, reason: 'error' }; }
        if (json?.remark && /runtime error|timed out|out of memory/i.test(json.remark)) { breakerResult('overpass', false); setNeg(key); return { ok: false, reason: 'error' }; }
        breakerResult('overpass', true); st.overpassOk++;
        const date = (json?.osm3s?.timestamp_osm_base || new Date(now()).toISOString()).slice(0, 10);
        return { ok: true, overlay: compactOverlay(json, x12, y12, date) };
      } finally { release('overpass'); }
    } catch { return { ok: false, reason: 'error' }; }
  }

  function sourceInfo() {
    rollDay();
    return {
      offline, pin: pin ? pin.ofm : null, src: pin ? `ofm:${pin.ofm}` : null, ...st,
      today: { ofm: day.ofm, overpass: day.overpass }, caps: { ofmDaily, overpassDaily },
      healthy: !offline && !breakerOpen('ofm'),
      breaker: Object.fromEntries([...breakers].map(([k, b]) => [k, { open: b.openUntil > now(), fails: b.fails }])),
    };
  }
  return { fetchBase, fetchBathy, fetchOverlay, sourceInfo, ensurePin, repin, latestVersion, get pin() { return pin ? pin.ofm : null; }, offline };
}

// ------------------------------------------------------------------------------------------------ default instance
let defaultSources = null;
const def = () => defaultSources || (defaultSources = createSources());
/** Replace the default instance (server start, tests, CLI). Returns it. */
export function configureSources(opts = {}) { defaultSources = createSources(opts); return defaultSources; }
export const fetchBase = (z, x, y) => def().fetchBase(z, x, y);
export const fetchOverlay = (x12, y12) => def().fetchOverlay(x12, y12);
export const fetchBathy = (x9, y9) => def().fetchBathy(x9, y9);
export const sourceInfo = () => def().sourceInfo();
export const sources = () => def();
