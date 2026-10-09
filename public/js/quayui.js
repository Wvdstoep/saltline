// Dock anywhere — client (docs/DOCK-ANYWHERE-CONTRACT.md §5). Moor at any real quay that fits the ship:
//   • Q (or the "Quays" button) asks the server for the quays near the ship (`quay_query`, re-asked every 2 s while the
//     card is open and the ship is not moored); the answer `{t: 'quays', list}` fills the card;
//   • the card: berth name and class, price per day, quay length / depth at low water against what the ship needs, why
//     not (too short / shallow / narrow / occupied / bridge / lock), the linked harbour and which of its services reach
//     this quay, "Moor here" (`quay_dock`), "Tugs" (`quay_tugs`) where the port sends them, ‹ › to step through quays;
//   • in 3D: the slot outline on the water the size of the ship (green = fits, amber = not), the quay stretch it uses
//     drawn along the face, and a light column on the slot from afar;
//   • moored at a quay (`you.berth.quay`): a small panel with the fee so far, the services, buttons that open the
//     existing harbour sheet tabs of the linked harbour (hud.openHarborTab), and Cast off (`undock`).
// Wiring (phase 2, docs/DOCK-ANYWHERE-PHASE2.md): main.js creates `new QuayUI(app)`, routes `quays` messages to
// onQuays, calls update(dt, now) per frame and toggle() on Q. Nothing here edits the HUD's own DOM.
import * as THREE from 'three';
import { QUAY, TIER_TABS } from '/shared/quayrules.js';
import { toLocal } from '/shared/geo.js';
import { cardModel, cardHTML, mooredModel, mooredHTML, pickCandidate, slotOutline, facePoint, faceFrame } from './quayfmt.js';

const QUERY_MS = 2000;
const COL = { fit: 0x4fe39a, nofit: 0xf2a134, face: 0xffffff };
const Y = 0.4;

export class QuayUI {
  constructor(app) {
    this.app = app;
    this.open = false; this.data = null; this.sel = null; this.lastAsk = 0; this.mooredOpen = true;
    this.group = new THREE.Group(); this.group.name = 'quayUI'; this.group.visible = false;
    app.scene?.add?.(this.group);
    this.fillMat = new THREE.MeshBasicMaterial({ color: COL.fit, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
    this.lineMat = new THREE.LineBasicMaterial({ color: COL.fit, transparent: true, opacity: 0.95 });
    this.faceMat = new THREE.LineBasicMaterial({ color: COL.face, transparent: true, opacity: 0.9 });
    this.beamMat = new THREE.MeshBasicMaterial({ color: COL.fit, transparent: true, opacity: 0.22, depthWrite: false });
    this.meshKey = null;
    this.el = null;
    this.ensureDom();
  }

  // ---------------------------------------------------------------- DOM
  ensureDom() {
    if (typeof document === 'undefined') return;
    if (!document.querySelector('link[data-quay-css]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/quay.css'; l.dataset.quayCss = '1'; document.head.appendChild(l);
    }
    const el = document.createElement('div');
    el.id = 'quayCard'; el.className = 'glass ctxCard quayCard hidden'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Moor at a quay');
    el.addEventListener('click', (e) => { const b = e.target.closest?.('[data-q]'); if (b && !b.disabled) this.onButton(b.dataset.q); });
    document.body.appendChild(el);
    this.el = el;
  }
  show(on) { if (this.el) this.el.classList.toggle('hidden', !on); }

  /** Q / the Quays button. */
  toggle() {
    const you = this.app.you;
    if (you?.berth?.quay) { this.mooredOpen = !this.mooredOpen; this.render(true); return; }
    this.open = !this.open;
    if (this.open) this.ask(true); else { this.show(false); this.group.visible = false; }
  }
  close() { this.open = false; this.mooredOpen = false; this.show(false); this.group.visible = false; }

  ask(force = false) {
    const now = Date.now();
    if (!force && now - this.lastAsk < QUERY_MS) return;
    this.lastAsk = now;
    this.app.net?.action?.('quay_query');
  }
  /** Server answer: { t: 'quays', list, missing, pending, busy, msg? } */
  onQuays(m) {
    this.data = m || null;
    const list = m?.list || [];
    this.sel = pickCandidate(list, this.sel?.id);
    if (m?.dockedAt) { this.open = false; this.mooredOpen = true; } // the server moored us (quay_dock / tugs done)
    this.render(true);
  }
  onButton(q) {
    const app = this.app, list = this.data?.list || [];
    if (q === 'close') return this.close();
    if (q === 'prev' || q === 'next') {
      if (!list.length) return;
      const i = Math.max(0, list.findIndex((c) => c.id === this.sel?.id));
      this.sel = list[(i + (q === 'next' ? 1 : -1) + list.length) % list.length];
      this.meshKey = null; return this.render(true);
    }
    if (q === 'moor' && this.sel) return app.net?.action?.('quay_dock', { id: this.sel.id });
    if (q === 'tugs' && this.sel) return app.net?.action?.('quay_tugs', { id: this.sel.id });
    if (q === 'castoff') return app.net?.action?.('undock');
    if (q.startsWith('tab:')) return app.hud?.openHarborTab?.(q.slice(4));
  }

  render(force = false) {
    if (!this.el) return;
    const app = this.app, you = app.you, s = app.ship;
    if (you?.berth?.quay) {
      if (!this.mooredOpen || app.hud?.harborOpen?.()) { this.show(false); return; }
      const m = mooredModel(you.berth, app.simTime, app.fleetView?.home ?? null);
      const tabs = tabsForTier(you.berth.tier);
      const html = mooredHTML(m, tabs);
      if (force || html !== this._html) { this.el.innerHTML = html; this._html = html; }
      this.el.classList.add('moored'); this.show(true); return;
    }
    this.el.classList.remove('moored');
    if (!this.open || you?.docked || app.ashore?.active) { this.show(false); return; }
    const list = this.data?.list || [];
    if (!list.length) {
      const msg = this.data?.busy ? 'The harbour office is busy — try again in a moment.' : this.data?.pending ? 'Reading the charts of this stretch…' : this.data ? 'No quay within 1.5 km. Sail closer to a quay wall, pier or pontoon.' : 'Looking for quays…';
      const html = `<div class="qHead"><div class="qTitle"><div class="qName">Moor at a quay</div><div class="qSub">${msg}</div></div><button class="qClose" data-q="close" aria-label="Close">×</button></div>`;
      if (html !== this._html) { this.el.innerHTML = html; this._html = html; }
      this.show(true); return;
    }
    const idx = Math.max(0, list.findIndex((c) => c.id === this.sel?.id));
    const m = cardModel(list[idx], { ship: s ? { lat: s.lat, lon: s.lon, hdg: s.hdg, spd: s.spd, cls: s.cls } : {}, money: you?.money, hail: !!you?.hail });
    const html = cardHTML(m, { index: idx, count: list.length, docked: !!you?.docked });
    if (force || html !== this._html) { this.el.innerHTML = html; this._html = html; }
    this.show(true);
  }

  // ---------------------------------------------------------------- per frame
  update(dt, now) {
    const app = this.app, you = app.you;
    if (this.open && you && !you.docked && !you.assist) this.ask();
    if (!(now - (this._renderAt || 0) < 250)) { this._renderAt = now; this.render(false); } // the card's numbers 4× a second
    const c = this.open && !you?.docked ? this.sel : null;
    if (!c || !c.face) { this.group.visible = false; return; }
    this.drawOutline(c);
  }

  drawOutline(c) {
    const app = this.app, key = `${c.id}|${c.slotId || ''}|${c.fits}`;
    const origin = c.face.a;
    if (this.meshKey !== key) {
      this.disposeMeshes();
      const loc = (p) => { const o = toLocal(p.lat, p.lon, origin); return new THREE.Vector3(o.x, 0, o.z); };
      const col = c.fits ? COL.fit : COL.nofit;
      this.fillMat.color.setHex(col); this.lineMat.color.setHex(col); this.beamMat.color.setHex(col);
      // the quay face (the whole run, white) and the stretch the ship uses
      const fa = loc(c.face.a), fb = loc(c.face.b);
      this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([fa, fb]), this.faceMat));
      const out = slotOutline(c);
      if (out) {
        const pts = out.map(loc);
        const shape = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[0], pts[2], pts[3]]);
        shape.computeVertexNormals();
        this.group.add(new THREE.Mesh(shape, this.fillMat));
        this.group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.lineMat));
        // chevrons on the water side pointing at the quay, every 40 m
        const f0 = faceFrame(c.face, c.slot.a.lat, c.slot.a.lon).along, f1 = faceFrame(c.face, c.slot.b.lat, c.slot.b.lon).along, off = QUAY.FENDER_M + (c.slot.beam || 10) + 8;
        const chev = [];
        for (let s = Math.min(f0, f1) + 20; s < Math.max(f0, f1) - 10; s += 40) {
          const tip = loc(facePoint(c.face, s, off - 4)), l = loc(facePoint(c.face, s - 4, off + 2)), r = loc(facePoint(c.face, s + 4, off + 2));
          chev.push(l, tip, tip, r);
        }
        if (chev.length) this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(chev), this.lineMat));
        const ctr = loc(c.slot);
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 120, 10, 1, true), this.beamMat);
        beam.position.set(ctr.x, 60, ctr.z); this.group.add(beam);
      } else {
        this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([fa, fb]), this.lineMat));
      }
      this.meshKey = key;
    }
    app.place?.(this.group, origin.lat, origin.lon, (app.tideLevel || 0) + Y);
    this.group.visible = true;
  }
  disposeMeshes() {
    for (const ch of [...this.group.children]) { this.group.remove(ch); ch.geometry?.dispose?.(); }
    this.meshKey = null;
  }
  dispose() { this.disposeMeshes(); this.app.scene?.remove?.(this.group); this.el?.remove?.(); }
}

/** Harbour-sheet tabs a quay tier reaches (= shared/quayrules.js TIER_TABS, without 'overview'). */
export function tabsForTier(tier) { return (TIER_TABS[tier] || TIER_TABS.none).filter((t) => t !== 'overview'); }
