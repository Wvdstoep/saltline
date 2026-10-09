// Bridges & locks in 3D (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §5, lane C). Draws every bridge and lock from the registry
// objects the server sends (`ww_static`), in its own scene group — NOT discarded inside harbour patches — and animates
// them from the server state (`ww` deltas): bascule / double bascule / draw leaves, lift spans with their cables, swing
// spans, pontoon / retractable sections, lock gates (mitre, sector, lift, rolling, drop), the chamber water that rises
// and falls with the ships on it, BPR signal lights, OpenSeaMap clearance boards, clearance gauges (peilschalen) with a
// live reading, and the ship's air-draught overlay. Geometry comes from the pure builders in wwgeom.js.
//
//   const ww = new WwMesh({ parent: scene, origin, phone, heightAt: (lat, lon) => y | null, now: () => serverMs });
//   ww.setStatics(objects); ww.applyDelta(delta); ww.setWater(h); ww.setOrigin(origin);
//   ww.update(dt, { lat, lon }) each frame;  ww.setShip({ lat, lon, hdg, need, beam, show }) for the overlay.
import * as THREE from 'three';
import { buildBridge, buildLock, partPose, anchorOf, llToLocal, localToLl, undersideAt, overlayStrip, bridgesAhead, inRing, planLod, BUDGET3D, LOD3D, datumOffset } from './wwgeom.js';
import { spanFrac, bridgeLights, lampsFor, gateFrac, chamberLevel, chamberFlow, lockHeadLights, gaugeReading, f1, clrNowLocal, verdictLocal, chamberPhase } from './wwfmt.js';

const LAMP_COL = { r: 0xff2a1a, g: 0x22ff6a, y: 0xffc21a };
const SLOT = { L: [-0.32, 0.28], R: [0.32, 0.28], B: [-0.32, -0.38], Y0: [0, 0.95], Y1: [-0.32, 0.95], Y2: [0.32, 0.95] };

/** LRU of canvas textures (boards, gauge readouts). Textures in use are never evicted. */
class TexCache {
  constructor(cap) { this.cap = cap; this.map = new Map(); }
  get(key, draw) {
    let e = this.map.get(key);
    if (e) { this.map.delete(key); this.map.set(key, e); e.refs++; return e.tex; }
    const tex = draw(); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    e = { tex, refs: 1 }; this.map.set(key, e); this.evict(); return tex;
  }
  release(key) { const e = this.map.get(key); if (e) e.refs = Math.max(0, e.refs - 1); this.evict(); }
  evict() { for (const [k, e] of this.map) { if (this.map.size <= this.cap) break; if (e.refs === 0) { e.tex.dispose(); this.map.delete(k); } } }
  get size() { return this.map.size; }
  dispose() { for (const e of this.map.values()) e.tex.dispose(); this.map.clear(); }
}
function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function boardCanvas(text, est, kind) {
  const W = kind === 'width' ? 384 : 480, H = kind === 'width' ? 136 : 160, c = canvas(W, H), x = c.getContext('2d');
  x.fillStyle = est ? '#c4c4c0' : '#fbfbf6'; x.fillRect(0, 0, W, H);
  x.strokeStyle = '#111'; x.lineWidth = 10; x.strokeRect(5, 5, W - 10, H - 10);
  x.fillStyle = '#0b0b0b'; x.textAlign = 'center'; x.textBaseline = 'middle';
  let fs = Math.round(H * 0.6); x.font = `700 ${fs}px "DejaVu Sans", Arial, sans-serif`;
  while (x.measureText(text).width > W - 30 && fs > 20) { fs -= 4; x.font = `700 ${fs}px "DejaVu Sans", Arial, sans-serif`; }
  x.fillText(text, W / 2, H / 2 + fs * 0.04);
  return new THREE.CanvasTexture(c);
}
/** Peilschaal: white scale, black decimetre marks (E pattern), clearance numbers at whole metres (ref − y). */
function gaugeCanvas(ref, y0, y1) {
  const ppm = 64, Hm = y1 - y0, H = Math.min(2048, Math.ceil(Hm * ppm)), k = H / Hm, W = 64, c = canvas(W, H), x = c.getContext('2d');
  x.fillStyle = '#fafaf5'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#111';
  const row = (y) => (y1 - y) * k;
  for (let d = Math.ceil(y0 * 10); d <= y1 * 10; d++) {
    const y = d / 10, r = row(y), clr = ref - y, cm = Math.round(clr * 10);
    const major = cm % 10 === 0, half = cm % 5 === 0;
    if ((cm & 1) === 0) x.fillRect(0, r - k * 0.05, major ? W * 0.62 : half ? W * 0.45 : W * 0.3, k * 0.1);
    if (major && clr > 0.3) { x.font = `700 ${Math.round(k * 0.42)}px "DejaVu Sans", Arial, sans-serif`; x.textAlign = 'right'; x.textBaseline = 'top'; x.fillText(String(Math.round(clr)), W - 3, r + 2); }
  }
  x.fillStyle = '#c0392b'; x.fillRect(W - 6, 0, 6, H);
  return new THREE.CanvasTexture(c);
}
function tagCanvas(text) {
  const W = 192, H = 80, c = canvas(W, H), x = c.getContext('2d');
  x.fillStyle = 'rgba(8,20,32,0.86)'; x.beginPath(); x.roundRect ? x.roundRect(2, 2, W - 4, H - 4, 14) : x.rect(2, 2, W - 4, H - 4); x.fill();
  x.strokeStyle = '#f2b134'; x.lineWidth = 4; x.stroke();
  x.fillStyle = '#fff'; x.font = '700 46px "DejaVu Sans", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, W / 2, H / 2 + 2);
  return new THREE.CanvasTexture(c);
}
function glowTexture() {
  const c = canvas(64, 64), x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function foamTexture() {
  const c = canvas(128, 128), x = c.getContext('2d'); x.clearRect(0, 0, 128, 128);
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 420; i++) { x.fillStyle = `rgba(255,255,255,${0.15 + rnd() * 0.5})`; x.beginPath(); x.arc(rnd() * 128, rnd() * 128, 1 + rnd() * 4, 0, Math.PI * 2); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function toGeometry(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  g.computeBoundingSphere();
  return g;
}
const yawOf = (n) => Math.atan2(n[0], n[2]);

export class WwMesh {
  /**
   * opts: { parent, origin {lat, lon}, phone, heightAt(lat, lon) → terrain y | null, now() → server ms, rules (lane A's
   * shared/waterworks.js module: clrNow, passVerdict), datumOffset(obj) (lane A shared/waterlevel.js), budget override }
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.B = { ...(opts.phone ? BUDGET3D.phone : BUDGET3D.desktop), ...(opts.budget || {}) };
    this.group = new THREE.Group(); this.group.name = 'waterworks';
    (opts.parent || opts.scene)?.add(this.group);
    this.origin = opts.origin || { lat: 52, lon: 4 };
    this.now = opts.now || (() => Date.now());
    this.rules = opts.rules || null;
    this.objs = new Map();               // id → { o, rev, state, built, dist, want }
    this.water = 0; this.night = 0; this.focus = null; this.lastLod = 0; this.queue = [];
    this.tex = new TexCache(this.B.textures);
    this.mat = {
      stat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.05, side: THREE.DoubleSide }),
      water: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.25, side: THREE.DoubleSide, transparent: true, opacity: 0.94 }),
      lampOff: new THREE.MeshBasicMaterial({ color: 0x2a2f33 }),
      lamp: Object.fromEntries(Object.entries(LAMP_COL).map(([k, c]) => [k, new THREE.MeshBasicMaterial({ color: c, toneMapped: false })])),
      overlay: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false }),
      foam: new THREE.MeshBasicMaterial({ map: foamTexture(), transparent: true, opacity: 0, depthWrite: false }),
    };
    this.glowTex = glowTexture();
    this.glowMat = Object.fromEntries(Object.entries(LAMP_COL).map(([k, c]) => [k, new THREE.SpriteMaterial({ map: this.glowTex, color: c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })]));
    this.lampGeo = new THREE.CircleGeometry(0.2, 12);
    this.overlay = null; this.ship = null;
    this.stats = { objects: 0, built: 0, full: 0, mid: 0, tris: 0, textures: 0, buildMs: 0 };
  }
  setRules(rules) { this.rules = rules || null; }
  setOrigin(origin) {
    this.origin = { lat: origin.lat, lon: origin.lon };
    for (const e of this.objs.values()) if (e.built) this.place(e);
  }
  setWater(h) { if (Number.isFinite(h)) this.water = h; }
  /** Water level at an object (opts.waterAt(lat, lon) when given — e.g. the two sides of a lock — else the global level). */
  waterOf(e) { const f = this.opts.waterAt; if (!f) return this.water; const a = e.anchor || (e.anchor = anchorOf(e.o)); const v = f(a.lat, a.lon); return Number.isFinite(v) ? v : this.water; }
  setNight(n) { this.night = Math.max(0, Math.min(1, n || 0)); }
  /** `ww_static`: objects (Bridge | Lock) — replaces an object whose rev changed. */
  setStatics(objects = []) {
    for (const o of objects) {
      if (!o || !o.id) continue;
      const cur = this.objs.get(o.id), rev = o.rev ?? 0;
      if (cur && cur.rev === rev && !cur.o.fromTile) continue;
      if (cur?.built) this.unbuild(cur);
      this.objs.set(o.id, { o, rev, state: cur?.state || null, built: null, dist: Infinity, want: 0, type: o.chambers ? 'lock' : 'bridge' });
    }
  }
  /** Tile-vector fallbacks (wwgeom.bridgeFromVector) for objects the registry has not sent: never replace registry objects. */
  setFallbacks(objects = []) {
    const keep = new Set();
    for (const o of objects) { if (!o?.id || (this.objs.has(o.id) && !this.objs.get(o.id).o.fromTile)) continue; keep.add(o.id); if (!this.objs.has(o.id)) this.objs.set(o.id, { o: { ...o, fromTile: true }, rev: -1, state: null, built: null, dist: Infinity, want: 0, type: 'bridge' }); }
    for (const [id, e] of this.objs) if (e.o.fromTile && !keep.has(id)) { if (e.built) this.unbuild(e); this.objs.delete(id); }
  }
  remove(id) { const e = this.objs.get(id); if (!e) return; if (e.built) this.unbuild(e); this.objs.delete(id); }
  /** `ww` delta {id, rev, st, t0, dur, sig, spans: [{i, st, t0, dur}], chambers: [...], out}. */
  applyDelta(d) {
    const e = this.objs.get(d?.id); if (!e) return;
    const prev = e.state || {};
    const spans = new Map((prev.spans || []).map((s) => [s.i, s]));
    for (const s of d.spans || []) spans.set(s.i, s);
    const chambers = new Map((prev.chambers || []).map((c) => [String(c.id), c]));
    for (const c of d.chambers || []) chambers.set(String(c.id), c);
    e.state = { ...prev, ...d, spans: [...spans.values()], chambers: [...chambers.values()] };
    if (!d.out && 'out' in d) delete e.state.out;
    e.sigKey = null;
  }
  knownIds() { const s = new Set(); for (const [id, e] of this.objs) if (!e.o.fromTile) s.add(id); return s; }
  get(id) { return this.objs.get(id) || null; }
  objects() { return [...this.objs.values()].map((e) => e.o); }
  stateOf(id) { return this.objs.get(id)?.state || null; }
  off(o) { return datumOffset(o, { datumOffset: this.opts.datumOffset }); }

  // ------------------------------------------------------------------------------------------ LOD + build queue
  update(dt, focus) {
    const now = performance.now();
    if (focus) this.focus = focus;
    if (this.focus && now - this.lastLod > 400) { this.lastLod = now; this.plan(); }
    // builds: at most buildsPerFrame and buildMs of main-thread time per frame (always at least one)
    const t0 = performance.now(); let n = 0;
    while (this.queue.length && n < this.B.buildsPerFrame && (n === 0 || performance.now() - t0 < this.B.buildMs)) {
      const e = this.queue.shift(); if (!e || e.want === (e.built?.lod ?? 0)) continue;
      this.build(e, e.want); n++;
    }
    if (n) this.stats.buildMs = performance.now() - t0;
    this.animate(this.now());
    this.updateOverlay();
  }
  plan() {
    const f = this.focus, all = [...this.objs.values()];
    for (const e of all) { const a = e.anchor || (e.anchor = anchorOf(e.o)); const [x, z] = llToLocal(f, a.lat, a.lon); e.dist = Math.hypot(x, z); }
    const want = planLod(all.map((e) => ({ dist: e.dist, type: e.type, tris: e.trisAt, builtLod: e.built?.lod, builtTris: e.built?.tris })), this.B);
    all.forEach((e, k) => {
      e.want = want[k];
      if (e.want === LOD3D.NONE && e.built) this.unbuild(e);
      else if (e.want && e.want !== (e.built?.lod ?? 0) && !this.queue.includes(e)) this.queue.push(e);
    });
    this.queue.sort((a, b) => a.dist - b.dist);
    this.stats.objects = this.objs.size;
  }
  /** Build everything in range now (harness, tests, warp arrival). */
  flush(focus) { if (focus) this.focus = focus; this.plan(); while (this.queue.length) { const e = this.queue.shift(); if (e.want !== (e.built?.lod ?? 0)) this.build(e, e.want); } this.animate(this.now()); }
  heightFn(anchor) {
    const h = this.opts.heightAt; if (!h) return null;
    return (x, z) => { const ll = localToLl(anchor, x, z); const v = h(ll.lat, ll.lon); return Number.isFinite(v) ? v : null; };
  }
  build(e, lod) {
    const anchor = e.anchor || (e.anchor = anchorOf(e.o));
    const opts = { lod, anchor, heightAt: this.heightFn(anchor), water: this.opts.meanWater ?? 0, datumOffset: this.opts.datumOffset, hi: this.opts.lockHi?.(e.o), lo: this.opts.lockLo?.(e.o) };
    let r = null;
    try { r = e.type === 'lock' ? buildLock(e.o, opts) : buildBridge(e.o, opts); } catch (err) { console.warn('[ww] build failed', e.o.id, err); }
    if (e.built) this.unbuild(e);
    if (!r) return;
    (e.trisAt ||= {})[lod] = r.tris;
    const root = new THREE.Group(); root.name = `ww:${e.o.id}`; root.userData.wwId = e.o.id;
    const st = new THREE.Mesh(toGeometry(r.static), this.mat.stat); st.userData.wwId = e.o.id; st.matrixAutoUpdate = false; root.add(st);
    const nodes = r.moving.map((p) => {
      const node = new THREE.Group(); node.position.set(...p.pivot); node.userData.part = p;
      const m = new THREE.Mesh(toGeometry(p.mesh), p.kind === 'water' ? this.mat.water : this.mat.stat); m.userData.wwId = e.o.id;
      if (p.kind === 'water') m.renderOrder = 1;
      node.add(m); root.add(node); return node;
    });
    const texKeys = [];
    const attach = (part, obj) => (part >= 0 ? nodes[part] : root).add(obj);
    for (const b of r.boards) {
      const key = `b:${b.kind}:${b.est ? 1 : 0}:${b.text}`; texKeys.push(key);
      const tex = this.tex.get(key, () => boardCanvas(b.text, b.est, b.kind));
      const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      m.position.set(...b.pos); m.rotation.y = yawOf(b.nrm); m.userData.wwId = e.o.id; attach(b.part, m);
    }
    const gauges = [];
    for (const g of r.gauges) {
      const key = `g:${g.ref.toFixed(2)}:${g.y0.toFixed(2)}:${g.y1.toFixed(2)}`; texKeys.push(key);
      const tex = this.tex.get(key, () => gaugeCanvas(g.ref, g.y0, g.y1));
      const h = g.y1 - g.y0;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(g.w, h), new THREE.MeshBasicMaterial({ map: tex }));
      m.position.set(g.pos[0] + g.nrm[0] * 0.03, g.y0 + h / 2, g.pos[2] + g.nrm[2] * 0.03); m.rotation.y = yawOf(g.nrm); attach(-1, m);
      let tag = null;
      if (g.face === 0) { tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false })); tag.scale.set(2.4, 1.0, 1); tag.position.set(g.pos[0] + g.nrm[0] * 1.6, 0, g.pos[2] + g.nrm[2] * 1.6); root.add(tag); }
      gauges.push({ g, tag, text: null });
    }
    const signals = r.signals.map((s) => {
      const hg = new THREE.Group(); hg.position.set(...s.pos); hg.rotation.y = yawOf(s.nrm); attach(s.part, hg);
      const lamps = {};
      for (const [slot, [x, y]] of Object.entries(SLOT)) {
        if (s.kind === 'span' && s.fixed && !slot.startsWith('Y')) continue;
        if (!(s.kind === 'span' && s.fixed) && slot.startsWith('Y')) continue;
        const m = new THREE.Mesh(this.lampGeo, this.mat.lampOff); m.position.set(x, y, 0.02); hg.add(m);
        const sp = new THREE.Sprite(this.glowMat.r); sp.position.set(x, y, 0.15); sp.visible = false; hg.add(sp);
        lamps[slot] = { m, sp };
      }
      return { s, lamps, key: null };
    });
    let foam = null;
    if (e.type === 'lock') {
      foam = r.cut.map((c) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(c.wid * 0.9, Math.min(40, c.len * 0.3)), this.mat.foam.clone()); m.visible = false; root.add(m); return { c, m }; });
    }
    e.built = { lod, root, nodes, r, texKeys, gauges, signals, foam, tris: r.tris };
    this.place(e);
    this.group.add(root);
    e.sigKey = null;
    this.recount();
  }
  place(e) { const a = e.anchor; const [x, z] = llToLocal(this.origin, a.lat, a.lon); e.built.root.position.set(x, 0, z); e.built.root.updateMatrixWorld(true); }
  unbuild(e) {
    const b = e.built; if (!b) return;
    this.group.remove(b.root);
    b.root.traverse((o) => { if (o.isMesh && o.geometry !== this.lampGeo) o.geometry.dispose(); if ((o.isMesh || o.isSprite) && o.material && !Object.values(this.mat).includes(o.material) && !Object.values(this.mat.lamp).includes(o.material) && !Object.values(this.glowMat).includes(o.material)) o.material.dispose(); });
    for (const k of b.texKeys) this.tex.release(k);
    for (const gg of b.gauges) if (gg.text) this.tex.release(gg.text);
    e.built = null; this.recount();
  }
  recount() {
    let tris = 0, full = 0, mid = 0, built = 0;
    for (const e of this.objs.values()) if (e.built) { built++; tris += e.built.tris; if (e.built.lod === LOD3D.FULL) full++; else mid++; }
    Object.assign(this.stats, { built, full, mid, tris, textures: this.tex.size });
  }

  // ------------------------------------------------------------------------------------------ animation
  /** Open fraction of span i of an object now (0…1) from its server state. */
  spanFracOf(e, i, now = this.now()) { const ss = (e.state?.spans || []).find((s) => s.i === i) || (e.state?.spans?.length ? null : e.state?.span0) || null; return spanFrac(ss, now); }
  chamberStateOf(e, id) { return (e.state?.chambers || []).find((c) => String(c.id) === String(id)) || null; }
  animate(now) {
    for (const e of this.objs.values()) {
      const b = e.built; if (!b) continue;
      for (const node of b.nodes) {
        const p = node.userData.part; let f = 0;
        if (p.kind === 'water') {
          const cs = this.chamberStateOf(e, p.chamber), cut = b.r.cut.find((c) => String(c.chamber) === String(p.chamber));
          const lvl = cs ? chamberLevel(cs, now, { A: cut?.area }) : this.water;
          node.position.set(p.pivot[0], lvl, p.pivot[2]); node.userData.level = lvl; continue;
        }
        if (p.kind === 'gate') f = gateFrac(this.chamberStateOf(e, p.chamber), p.head, now);
        else f = this.spanFracOf(e, p.span, now);
        const pose = partPose(p, f);
        node.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
        if (pose.angle) node.quaternion.setFromAxisAngle(new THREE.Vector3(...pose.axis), pose.angle); else node.quaternion.identity();
        node.scale.y = pose.sy;
      }
      this.animateSignals(e, now);
      if (b.foam) for (const fm of b.foam) {
        const cs = this.chamberStateOf(e, fm.c.chamber), fl = cs ? chamberFlow(cs, now) : 0;
        fm.m.visible = fl > 0.02;
        if (fm.m.visible) {
          const ph = chamberPhase(cs), dest = 1 - ph.side, rising = (Number(cs.level1) || 0) > (Number(cs.level0) || 0);
          const lvl = chamberLevel(cs, now, { A: fm.c.area }), out = dest === 0 ? -1 : 1;
          const uu = rising ? fm.c.gU[dest] - out * 14 : fm.c.gU[dest] + out * 20;
          const y = rising ? lvl + 0.05 : (Number(cs.level1) || 0) + 0.05;
          fm.m.position.set(fm.c.C[0] + fm.c.u[0] * uu, y, fm.c.C[1] + fm.c.u[1] * uu);
          fm.m.rotation.set(-Math.PI / 2, Math.atan2(fm.c.u[0], fm.c.u[1]), 0, 'YXZ');
          fm.m.material.opacity = 0.75 * Math.sqrt(fl); fm.m.material.map.offset.y = (now / 4000) % 1;
        }
      }
      const wl = this.waterOf(e);
      for (const gg of b.gauges) if (gg.tag) {
        const v = gaugeReading(gg.g.ref - wl), text = v == null ? '' : f1(v);
        if (text !== gg.text) {
          if (gg.text) this.tex.release(gg.text);
          gg.text = `t:${text}`; gg.tag.material.map = this.tex.get(gg.text, () => tagCanvas(text)); gg.tag.material.needsUpdate = true;
        }
        gg.tag.position.y = wl + 1.1;
      }
    }
  }
  animateSignals(e, now) {
    const b = e.built, st = e.state || {};
    for (const sg of b.signals) {
      const s = sg.s; let tokens;
      if (s.kind === 'head') tokens = lockHeadLights(this.chamberStateOf(e, s.chamber), s.head, s.face, !!st.out);
      else {
        const ss = (st.spans || []).find((x) => x.i === s.span);
        tokens = bridgeLights({ spanState: ss, objState: st, sig: (st.sig || []).filter((x) => x.span == null || x.span === s.span), face: s.face, fixed: !!s.fixed, narrow: !!s.narrow });
        void now;
      }
      const key = tokens.join(',') + (this.night > 0.5 ? 'n' : 'd');
      if (key === sg.key) continue; sg.key = key;
      const on = new Map(lampsFor(tokens).map((l) => [l.slot, l.col]));
      for (const [slot, l] of Object.entries(sg.lamps)) {
        const col = on.get(slot);
        l.m.material = col ? this.mat.lamp[col] : this.mat.lampOff;
        l.sp.visible = !!col; if (col) { l.sp.material = this.glowMat[col]; const k = this.night > 0.5 ? 4.5 : 2.2; l.sp.scale.set(k, k, 1); }
      }
    }
  }

  // ------------------------------------------------------------------------------------------ queries
  /** World (origin frame) → object frame of entry e. */
  toObj(e, x, z) { const a = e.anchor, [ax, az] = llToLocal(this.origin, a.lat, a.lon); return [x - ax, z - az]; }
  /** Deck underside (world y) above world point (x, z) over every built bridge, or null. */
  undersideWorld(x, z) {
    let best = null;
    for (const e of this.objs.values()) {
      if (e.type !== 'bridge' || !e.built?.r.query) continue;
      const [ox, oz] = this.toObj(e, x, z), q = e.built.r.query;
      const fr = {}; for (const sp of q.spans) fr[sp.i] = this.spanFracOf(e, sp.i);
      const u = undersideAt(q, ox, oz, fr); if (u != null && (best == null || u < best)) best = u;
    }
    return best;
  }
  /** Chamber water level (y) at lat/lon when the point is inside a lock chamber, else null (ships in a chamber ride it). */
  chamberLevelAt(lat, lon) {
    for (const e of this.objs.values()) {
      if (e.type !== 'lock' || !e.built) continue;
      const [x, z] = llToLocal(e.anchor, lat, lon);
      for (const c of e.built.r.cut) if (inRing(c.ring, x, z)) { const cs = this.chamberStateOf(e, c.chamber); return cs ? chamberLevel(cs, this.now(), { A: c.area }) : null; }
    }
    return null;
  }
  /** Lock chamber footprints for the ocean cut-outs: [{id, chamber, ring: [[lat, lon]…], level}]. */
  cutouts() {
    const out = [];
    for (const e of this.objs.values()) {
      if (e.type !== 'lock' || !e.built) continue;
      for (const c of e.built.r.cut) { const cs = this.chamberStateOf(e, c.chamber); out.push({ id: e.o.id, chamber: c.chamber, ring: c.ring.map(([x, z]) => { const p = localToLl(e.anchor, x, z); return [p.lat, p.lon]; }), level: cs ? chamberLevel(cs, this.now(), { A: c.area }) : null }); }
    }
    return out;
  }
  /** True when (lat, lon) lies within m metres of a registry bridge line (harbor.js skipNear). */
  lineNear(lat, lon, m = 20) {
    for (const e of this.objs.values()) {
      if (e.type !== 'bridge' || e.o.fromTile || !e.o.line) continue;
      const f = { lat, lon }, pts = e.o.line.map(([a, b]) => llToLocal(f, a, b));
      for (let i = 0; i + 1 < pts.length; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, -(ax * dx + az * dz) / L2)); if (Math.hypot(ax + dx * t, az + dz * t) <= m) return true; }
    }
    return false;
  }
  /**
   * The next bridges ahead with verdicts for the HUD strip: [{id, name, verdict, clrNow, clrOpenNow, need, dist, vhf, span}].
   * air = you.air ({ad, need, B}); h = water level now; Hs = local sea.
   */
  objectsAhead(lat, lon, hdg, air, { h = null, Hs = 0, n = 3, maxM = 5000 } = {}) {
    const objs = []; for (const e of this.objs.values()) if (e.type === 'bridge') objs.push(e.o);
    return bridgesAhead(objs, lat, lon, hdg, maxM, n).map((a) => {
      const e = this.objs.get(a.id), off = this.off(a.obj), frac = this.spanFracOf(e, a.span);
      const hh = this.opts.waterAt || !Number.isFinite(h) ? this.waterOf(e) : h;
      const ctx = { h: hh, off, Hs, frac, state: (e.state?.spans || []).find((s) => s.i === a.span) || e.state };
      let v = null;
      try { if (this.rules?.passVerdict) v = this.rules.passVerdict(air, a.obj, a.span, { ...ctx, t: this.now(), water: { h: hh } }); } catch { v = null; }
      if (!v || !v.verdict) v = verdictLocal(air, a.obj, a.span, ctx);
      return { id: a.id, name: a.obj.callName || a.obj.name, verdict: v.verdict, open: !!v.open || (v.verdict === 'opening' && frac >= 0.999), clrNow: v.clrNow, clrOpenNow: v.clrOpenNow, need: v.need, dist: a.dist, vhf: a.obj.vhf, span: a.span };
    });
  }
  /** clrNow of span i (lane A's clrNow when wired; frac from the live state). */
  clrNow(id, i, h) {
    const e = this.objs.get(id); if (!e) return null;
    if (!Number.isFinite(h)) h = this.waterOf(e);
    const frac = this.spanFracOf(e, i), off = this.off(e.o);
    try { if (this.rules?.clrNow) { const v = this.rules.clrNow(e.o, i, { h, frac }); if (Number.isFinite(v) || v === Infinity) return v; } } catch { /* fallback */ }
    return clrNowLocal(e.o, i, { h, frac, off });
  }
  /** Raycast pick: the waterworks object id under a THREE.Raycaster, or null. */
  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.group.children, true);
    for (const h of hits) { let o = h.object; while (o && !o.userData.wwId) o = o.parent; if (o?.userData.wwId) return { id: o.userData.wwId, point: h.point, dist: h.distance }; }
    return null;
  }

  // ------------------------------------------------------------------------------------------ air-draught overlay
  /** ship: { lat, lon, hdg, need (m above water), beam, show } — the band at the need height 200 m ahead (§5.2). */
  setShip(ship) { this.ship = ship; }
  updateOverlay() {
    const s = this.ship;
    if (!s || !s.show || !Number.isFinite(s.need)) { if (this.overlay) this.overlay.visible = false; return; }
    const [x, z] = llToLocal(this.origin, s.lat, s.lon);
    const r = overlayStrip({ x, z, hdg: s.hdg, need: s.need, beam: s.beam || 8, water: this.water }, (px, pz) => this.undersideWorld(px, pz), s.len || 200, 4);
    if (!this.overlay) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(r.col, 3)); g.setIndex(new THREE.BufferAttribute(r.idx, 1));
      this.overlay = new THREE.Mesh(g, this.mat.overlay); this.overlay.renderOrder = 5; this.overlay.frustumCulled = false; this.group.add(this.overlay);
    } else {
      const g = this.overlay.geometry; g.attributes.position.array.set(r.pos); g.attributes.color.array.set(r.col); g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    }
    this.overlay.visible = true; this.overlayInfo = { red: r.red, firstRed: r.firstRed, y: r.y };
  }

  dispose() {
    for (const e of this.objs.values()) if (e.built) this.unbuild(e);
    this.objs.clear(); this.tex.dispose(); this.glowTex.dispose(); this.lampGeo.dispose();
    for (const m of [this.mat.stat, this.mat.water, this.mat.lampOff, this.mat.overlay, this.mat.foam, ...Object.values(this.mat.lamp), ...Object.values(this.glowMat)]) m.dispose?.();
    if (this.overlay) { this.overlay.geometry.dispose(); this.group.remove(this.overlay); }
    this.group.parent?.remove(this.group);
  }
}
