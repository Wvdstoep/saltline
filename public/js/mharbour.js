// Inland harbours and marinas in 3D (player report: "inland harbours show no docks, and the map does not show the harbour
// in detail like the large harbours do"). Streams the geometry records of the harbours near the ship
// (GET /api/mh/geo — pontoons, quays, gangways, hut, fuel berth; shared/mhgeo.js) and builds them with public/js/mhgeom.js
// under a budget (desktop 10 harbours / 160k tris, phones 5 / 50k; FULL detail close in, MID further out, nothing beyond),
// one build per frame within a few ms. Labels: the harbour sign on the hut, the harbour master's channel, FUEL, and the box
// numbers of the boxes nearest the ship (full detail only). The same layouts feed the radar underlay (segmentsNear), the
// chart outlines (public/js/mhchart.js) and the berth guidance plan (public/js/berthguide.js).
//
//   const mh = new MHarbour(app, { phone });  mh.update(dt, now) each frame;  mh.segmentsNear(lat, lon, rM);  mh.dispose()
import * as THREE from 'three';
import { toLocal } from '/shared/geo.js';
import { layoutOf, segmentsOf, structureAt, MHG } from '/shared/mhgeo.js';
import { depthOf } from '/shared/mharbour.js';
import { buildMinorHarbour, planMhLod, estTris, MHLOD } from './mhgeom.js';
import { makeLabel } from './ship.js';

const FETCH_MS = 8000, RETRY_MS = 5000, MOVE_M = 600, PLAN_MS = 700, KEEP_KM = 6;
const BOXNO_R = 220, DEPTH_PAD_M = 70;
const dist = (a, b, c, d) => { const k = 111320 * Math.cos(a * Math.PI / 180); return Math.hypot((d - b) * k, (c - a) * 110574); };

function toGeometry(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  g.computeBoundingSphere();
  return g;
}

export class MHarbour {
  constructor(app, opts = {}) {
    this.app = app; this.phone = !!opts.phone;
    this.B = { ...(this.phone ? MHG.BUDGET.phone : MHG.BUDGET.desktop), ...(opts.budget || {}) };
    this.fetchImpl = opts.fetchImpl || ((u) => fetch(u).then((r) => r.json()));
    this.group = new THREE.Group(); this.group.name = 'minorHarbours'; app.scene?.add(this.group);
    this.items = new Map();     // id → { geo, lay, dist, want, built: { root, float, fixed, lod, tris, labels }, trisAt }
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.04, side: THREE.DoubleSide });
    this.lastFetch = -1e9; this.fetchAt = null; this.busy = false; this.lastPlan = 0; this.queue = []; this.version = 0;
    this.boxLabels = []; this.boxKey = '';
    this.stats = { harbours: 0, built: 0, full: 0, mid: 0, tris: 0, fetches: 0, pending: 0, buildMs: 0 };
  }

  // ---------------------------------------------------------------- streaming
  wantFetch(s, now) {
    if (this.busy) return false;
    const moved = !this.fetchAt || dist(this.fetchAt.lat, this.fetchAt.lon, s.lat, s.lon) > MOVE_M;
    const pending = [...this.items.values()].some((e) => e.geo.pending);
    return moved ? now - this.lastFetch > 1500 : now - this.lastFetch > (pending ? RETRY_MS : FETCH_MS * 4);
  }
  fetchNear(s, now) {
    this.busy = true; this.lastFetch = now; this.fetchAt = { lat: s.lat, lon: s.lon }; this.stats.fetches++;
    const r = this.phone ? 2.2 : 3.5, n = this.phone ? 6 : 12;
    return this.fetchImpl(`/api/mh/geo?lat=${s.lat.toFixed(5)}&lon=${s.lon.toFixed(5)}&r=${r}&n=${n}`).then((j) => this.ingest(j?.harbours || [], s)).catch(() => {}).finally(() => { this.busy = false; });
  }
  /** Fetch specific harbours (the chart at high zoom). */
  fetchIds(ids) {
    const want = ids.filter((id) => !this.items.has(id)).slice(0, 16);
    if (!want.length || this.busyIds) return;
    this.busyIds = true;
    this.fetchImpl(`/api/mh/geo?ids=${want.map(encodeURIComponent).join(',')}`).then((j) => this.ingest(j?.harbours || [], this.app.ship || null)).catch(() => {}).finally(() => { this.busyIds = false; });
  }
  ingest(list, s) {
    for (const g of list) {
      if (!g?.id) continue;
      const cur = this.items.get(g.id);
      if (g.pending) { if (!cur) this.items.set(g.id, { geo: g, lay: null, dist: Infinity, want: 0, built: null }); continue; }
      if (cur && cur.geo && !cur.geo.pending && JSON.stringify(cur.geo.pont) === JSON.stringify(g.pont) && cur.geo.hut?.lat === g.hut?.lat) continue;
      if (cur?.built) this.unbuild(cur);
      let lay = null; try { lay = layoutOf(g); } catch (e) { console.warn('[mh] layout failed', g.id, e); }
      this.items.set(g.id, { geo: g, lay, dist: Infinity, want: 0, built: null, est: { [MHLOD.MID]: estTris(g, MHLOD.MID), [MHLOD.FULL]: estTris(g, MHLOD.FULL) } });
      this.version++;
    }
    // forget harbours far behind
    if (s) for (const [id, e] of this.items) if (!e.geo.pending && dist(s.lat, s.lon, e.geo.lat, e.geo.lon) > KEEP_KM * 1000) { if (e.built) this.unbuild(e); this.items.delete(id); this.version++; }
    this.lastPlan = 0;
  }

  // ---------------------------------------------------------------- per frame
  update(dt, now) {
    const app = this.app, s = app.ship; if (!s) return;
    if (this.wantFetch(s, now)) this.fetchNear(s, now);
    if (now - this.lastPlan > PLAN_MS) { this.lastPlan = now; this.plan(s); }
    const t0 = performance.now(); let n = 0;
    while (this.queue.length && (n === 0 || performance.now() - t0 < this.B.buildMs)) {
      const e = this.queue.shift(); if (!e || e.want === (e.built?.lod ?? 0)) continue;
      this.build(e, e.want); n++;
    }
    if (n) this.stats.buildMs = Math.round((performance.now() - t0) * 10) / 10;
    const level = Number.isFinite(app.tideLevel) ? app.tideLevel : 0;
    for (const e of this.items.values()) {
      const b = e.built; if (!b) continue;
      app.place(b.root, b.anchor.lat, b.anchor.lon, 0);
      b.float.position.y = level;
    }
    this.updateBoxLabels(s, now);
  }
  plan(s) {
    const all = [...this.items.values()].filter((e) => e.lay);
    for (const e of all) e.dist = dist(s.lat, s.lon, e.geo.lat, e.geo.lon);
    const want = planMhLod(all.map((e) => ({ dist: e.dist, tris: e.trisAt, est: e.est })), this.B);
    all.forEach((e, k) => {
      e.want = want[k];
      if (e.want === MHLOD.NONE && e.built) this.unbuild(e);
      else if (e.want && e.want !== (e.built?.lod ?? 0) && !this.queue.includes(e)) this.queue.push(e);
    });
    this.queue.sort((a, b) => a.dist - b.dist);
    this.stats.harbours = this.items.size; this.stats.pending = [...this.items.values()].filter((e) => e.geo.pending).length;
  }
  heightAt() { const t = this.app.terrain; return t?.heightAt ? (lat, lon) => { const v = t.heightAt(lat, lon); return Number.isFinite(v) && v > 0 ? v : null; } : null; }
  build(e, lod) {
    let r = null;
    try { r = buildMinorHarbour(e.geo, { lod, lay: e.lay, heightAt: this.heightAt() }); } catch (err) { console.warn('[mh] build failed', e.geo.id, err); }
    if (e.built) this.unbuild(e);
    if (!r) return;
    (e.trisAt ||= {})[lod] = r.tris;
    const root = new THREE.Group(); root.name = `mh:${e.geo.id}`;
    const float = new THREE.Group(), fixed = new THREE.Group();
    if (r.float.tris) { const m = new THREE.Mesh(toGeometry(r.float), this.mat); m.receiveShadow = true; float.add(m); }
    if (r.fixed.tris) { const m = new THREE.Mesh(toGeometry(r.fixed), this.mat); m.receiveShadow = true; fixed.add(m); }
    const labels = [];
    if (lod >= MHLOD.FULL) for (const l of r.labels) {
      const color = l.kind === 'fuel' ? '#ffd166' : l.kind === 'vhf' ? '#cfe6ff' : '#ffffff';
      const sp = makeLabel(l.text, color, l.small ? 30 : 38, { height: l.small ? 2.2 : 3.2, minPx: l.small ? 16 : 22, maxPx: l.small ? 26 : 34 });
      sp.position.set(l.pos[0], l.pos[1], l.pos[2]); (l.fixed ? fixed : float).add(sp); labels.push(sp);
    }
    root.add(float, fixed);
    this.group.add(root);
    e.built = { root, float, fixed, lod, tris: r.tris, labels, anchor: r.anchor };
    this.app.place(root, r.anchor.lat, r.anchor.lon, 0);
    this.recount();
  }
  unbuild(e) {
    const b = e.built; if (!b) return;
    this.group.remove(b.root);
    b.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); if (o.isSprite) { o.material.map?.dispose(); o.material.dispose(); } });
    e.built = null; this.recount();
  }
  recount() {
    let built = 0, full = 0, mid = 0, tris = 0;
    for (const e of this.items.values()) if (e.built) { built++; tris += e.built.tris; if (e.built.lod === MHLOD.FULL) full++; else mid++; }
    Object.assign(this.stats, { built, full, mid, tris });
  }
  /** Numbered posts: sprites for the boxes nearest the ship (full-detail harbours only, budget B.labels). */
  updateBoxLabels(s, now) {
    if (now - (this.boxAt || 0) < 1000) return; this.boxAt = now;
    const near = [];
    for (const e of this.items.values()) {
      if (e.built?.lod !== MHLOD.FULL || !e.lay || e.dist > 1500) continue;
      for (const b of e.lay.boxes) { const d = dist(s.lat, s.lon, b.lat, b.lon); if (d <= BOXNO_R) near.push({ e, b, d }); }
    }
    near.sort((a, b) => a.d - b.d);
    const pick = near.slice(0, this.B.labels), key = pick.map((x) => x.b.id).join(',');
    if (key === this.boxKey) return;
    this.boxKey = key;
    for (const l of this.boxLabels) { l.parent?.remove(l); l.material.map?.dispose(); l.material.dispose(); }
    this.boxLabels = [];
    for (const { e, b } of pick) {
      const post = b.c[2], p = toLocal(post[0], post[1], e.built.anchor);
      const sp = makeLabel(String(b.no), '#ffffff', 34, { height: 1.4, minPx: 12, maxPx: 22 });
      sp.position.set(p.x, 2.9, p.z); e.built.fixed.add(sp); this.boxLabels.push(sp);
    }
  }

  // ---------------------------------------------------------------- queries (radar, chart, guidance plan, tests)
  layouts() { return [...this.items.values()].filter((e) => e.lay).map((e) => ({ geo: e.geo, lay: e.lay })); }
  /** Pontoon / quay / gangway / finger outlines within rM of a point: [{ a, b, w, k }]. */
  segmentsNear(lat, lon, rM = 3000) {
    const out = [];
    for (const e of this.items.values()) if (e.lay && dist(lat, lon, e.geo.lat, e.geo.lon) <= rM + 600) out.push(...segmentsOf(e.lay));
    return out;
  }
  /**
   * Depth (m) to sail on inside an inland harbour: within DEPTH_PAD_M of its pontoons / quays the harbour's depth (data,
   * else the tier default of the card, shared/mharbour.js depthOf) — the keel check uses the deeper of this and the tiles.
   */
  depthAt(lat, lon) {
    for (const e of this.items.values()) {
      if (!e.lay || dist(lat, lon, e.geo.lat, e.geo.lon) > 900) continue;
      if (structureAt(e.lay, lat, lon, DEPTH_PAD_M)) return depthOf(e.geo).m;
    }
    return null;
  }
  structureAt(lat, lon) { for (const e of this.items.values()) if (e.lay && dist(lat, lon, e.geo.lat, e.geo.lon) < 900) { const k = structureAt(e.lay, lat, lon); if (k) return k; } return null; }
  debug() {
    return { ...this.stats, items: [...this.items.values()].map((e) => ({ id: e.geo.id, name: e.geo.name, tier: e.geo.tier, pending: !!e.geo.pending, synth: !!e.geo.synth, dist: Math.round(e.dist), lod: e.built?.lod ?? 0, tris: e.built?.tris ?? 0, boxes: e.lay?.boxes.length ?? 0, decks: e.lay?.decks.length ?? 0 })), boxLabels: this.boxLabels.length };
  }
  dispose() { for (const e of this.items.values()) if (e.built) this.unbuild(e); this.items.clear(); this.app.scene?.remove(this.group); this.mat.dispose(); }
}
