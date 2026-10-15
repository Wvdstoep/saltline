// Shared, size-capped PBR textures (the casino set, and the few the legacy interiors use).
//
// Why this exists: every material used to TextureLoader.load() its own copy of each map at full size, decoded on the main
// thread at first draw. One casino visit put ~28 copies (5.3 MB each on the GPU) plus GLTF props and an HDR on the GPU at
// once and hung the tab. Here:
//   - one Texture per (file, size, repeat): materials that use the same file share it;
//   - the file is decoded off the main thread (fetch → createImageBitmap with resizeWidth/Height: ≤ 1024 px desktop,
//     ≤ 512 px phones), uploaded once with renderer.initTexture() and the decoded bitmap is released right after;
//   - until it arrives the material samples a 1×1 placeholder of the same kind, so the shader never changes when the
//     real map is swapped in (no recompile, no hitch): the room shows plain colours first and sharpens as maps land;
//   - a group ('casino', 'interior') is released as a whole: textures freed on the GPU, materials back on placeholders.
import * as THREE from 'three';

const PH = {};
/** The 1×1 stand-in of a map kind: 'color' white, 'normal' flat, 'arm' (AO 1, roughness 1, metal 0). */
export function placeholder(kind = 'color') {
  if (PH[kind]) return PH[kind];
  const px = kind === 'normal' ? [128, 128, 255, 255] : kind === 'arm' ? [255, 255, 0, 255] : [255, 255, 255, 255];
  const t = new THREE.DataTexture(new Uint8Array(px), 1, 1);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  t.userData.shared = true; t.userData.placeholder = true;
  return (PH[kind] = t);
}

const entries = new Map();     // key → entry
const extra = new Map();       // other GPU memory the budget line counts (canvas textures, the room's PMREM)
let renderer = null, running = 0, restoreHooked = null;
const MAX_PARALLEL = 2;

const browser = () => typeof window !== 'undefined' && typeof fetch === 'function' && typeof createImageBitmap === 'function';
const frame = () => new Promise((res) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => res()) : setTimeout(res, 0)));

/** Use this renderer for the up-front uploads (and reload everything if its context comes back after a loss). */
export function setTexRenderer(r) {
  if (!r || r === renderer) return;
  renderer = r;
  const el = r.domElement;
  if (el?.addEventListener && restoreHooked !== el) { restoreHooked = el; el.addEventListener('webglcontextrestored', reloadAll); }
}

/**
 * Bind `url` into `mat[slot]` for `group`. opts: { size (max px), srgb, kind: 'color'|'normal'|'arm', repeat: [u, v],
 * aniso, onLoad(mat), onUnload(mat) }. The material gets the placeholder now and the real texture when it is decoded
 * (after loadGroup(group)). Returns the entry.
 */
export function bindTex(group, mat, slot, url, opts = {}) {
  const size = opts.size || 1024, rep = opts.repeat || [1, 1];
  const key = `${url}|${size}|${rep[0]}x${rep[1]}`;
  let e = entries.get(key);
  if (!e) { e = { key, url, size, rep, srgb: !!opts.srgb, aniso: opts.aniso || 4, kind: opts.kind || (opts.srgb ? 'color' : 'normal'), tex: null, state: 'cold', bytes: 0, binds: [], groups: new Set() }; entries.set(key, e); }
  e.groups.add(group);
  const b = { group, mat, slot, onLoad: opts.onLoad, onUnload: opts.onUnload };
  e.binds.push(b);
  if (e.tex) { mat[slot] = e.tex; b.onLoad?.(mat); } else mat[slot] = placeholder(e.kind);
  return e;
}

/** Start decoding every texture of `group` in the background (no-op outside a browser). */
export function loadGroup(group) {
  if (!browser()) return;
  for (const e of entries.values()) if (e.groups.has(group) && e.state === 'cold') { e.state = 'queued'; }
  pump();
}

function pump() {
  while (running < MAX_PARALLEL) {
    const e = [...entries.values()].find((q) => q.state === 'queued');
    if (!e) return;
    e.state = 'loading'; running++;
    load(e).catch((err) => { console.warn('[casino] texture', e.url, err?.message || err); if (entries.get(e.key) === e) e.state = 'failed'; })
      .finally(() => { running--; pump(); });
  }
}

async function decode(url, size) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  try {   // decoded and scaled off the main thread; flipped here because WebGL cannot flip an ImageBitmap on upload
    return await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high', imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {   // a browser without the options: decode, then scale and flip on a small canvas
    const full = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const g = c.getContext('2d'); g.translate(0, size); g.scale(1, -1); g.drawImage(full, 0, 0, size, size);
    full.close?.();
    return c;
  }
}

async function load(e) {
  const img = await decode(e.url, e.size);
  await frame();   // one upload per frame at most
  if (entries.get(e.key) !== e || e.state !== 'loading') { img.close?.(); return; }   // released while it was decoding
  const t = new THREE.Texture(img);
  t.flipY = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(e.rep[0], e.rep[1]);
  t.anisotropy = Math.min(e.aniso, renderer?.capabilities?.getMaxAnisotropy?.() || e.aniso);
  if (e.srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.userData.shared = true;
  t.needsUpdate = true;
  const release = () => { img.close?.(); if (img.width !== undefined && img.getContext) { img.width = img.height = 1; } };
  if (renderer?.initTexture) { try { renderer.initTexture(t); release(); } catch { t.onUpdate = () => { release(); t.onUpdate = null; }; } }
  else t.onUpdate = () => { release(); t.onUpdate = null; };
  e.tex = t; e.state = 'ready'; e.bytes = Math.round(e.size * e.size * 4 * 4 / 3);
  for (const b of e.binds) { b.mat[b.slot] = t; b.onLoad?.(b.mat); }
  if (![...entries.values()].some((q) => q.state === 'queued' || q.state === 'loading' && q !== e)) logBudget();
}

/** Drop `group`: its materials go back to placeholders and textures nobody else uses are freed on the GPU. */
export function releaseGroup(group) {
  let freed = 0;
  for (const [key, e] of entries) {
    if (!e.groups.has(group)) continue;
    for (const b of e.binds) if (b.group === group) { b.mat[b.slot] = placeholder(e.kind); b.onUnload?.(b.mat); }
    e.binds = e.binds.filter((b) => b.group !== group);
    e.groups.delete(group);
    if (!e.groups.size) { if (e.tex) { e.tex.dispose(); freed++; } e.tex = null; e.state = 'dead'; entries.delete(key); }
  }
  return freed;
}

function reloadAll() {   // after a lost context the uploads are gone and the bitmaps were released: decode again
  for (const e of entries.values()) {
    if (!e.tex) continue;
    for (const b of e.binds) { b.mat[b.slot] = placeholder(e.kind); b.onUnload?.(b.mat); }
    e.tex.dispose(); e.tex = null; e.state = 'queued';
  }
  pump();
}

/** Count other GPU memory (bytes) under `key` in the budget line; null removes it. */
export function noteBytes(key, bytes) { if (bytes == null) extra.delete(key); else extra.set(key, bytes); }
/** Bytes of a texture of w × h RGBA8 with mipmaps. */
export const texBytes = (w, h, mips = true) => Math.round(w * h * 4 * (mips ? 4 / 3 : 1));

/** { n, mb, files, other }: textures on the GPU now (files decoded + canvases / env counted with noteBytes). */
export function texBudget(group = null) {
  let n = 0, b = 0, files = 0;
  for (const e of entries.values()) if (e.tex && (!group || e.groups.has(group))) { n++; files++; b += e.bytes; }
  for (const v of extra.values()) { n++; b += v; }
  return { n, mb: b / 1048576, files, other: extra.size };
}
/** The planned budget (as if every bound file of `group` were loaded): for tests and the log before loads finish. */
export function texPlan(group) {
  let n = 0, b = 0;
  for (const e of entries.values()) if (e.groups.has(group)) { n++; b += Math.round(e.size * e.size * 4 * 4 / 3); }
  for (const v of extra.values()) { n++; b += v; }
  return { n, mb: b / 1048576 };
}
export function logBudget() {
  const q = texBudget();
  console.info(`[casino] textures ${q.n}, ~${q.mb.toFixed(1)} MB (${q.files} files, ${q.other} canvas/env)`);
  return q;
}
export const _casinotex = { entries, extra };
