// Chart-aware autopilot (docs/V6-QUICK-CONTRACTS.md §4.6). Plans every route with the server route planner v2
// (/api/route: water deep enough for the ship's draught at low water, harbour fairways, the Dover TSS lanes, round storm
// cells), steers it waypoint by waypoint, caps the telegraph in harbour approaches (10 → 6 → 4 kn), hands over to the
// berth guidance line at the approach point and stops off the berth, and re-plans when shallows show up ahead, the ship
// is far off the leg, or a storm cell lies across the route. app.route stays the single source of truth (points may
// carry `mark`, `name` and `wp`); app.routeMeta describes a planned route (null for a raw waypoint).
import { SHIP_CLASSES, WARP } from '/shared/constants.js';
import { haversine, bearing, angleDiff, fmtDistance } from '/shared/geo.js';
import { PILOT, speedCapKn, throttleCap, lookAheadM, firstShoal, offRouteM, shouldReplan, handoverStep, stormOnRoute } from './pilotcore.js';

const WARP_MAX_NO_ROUTE = Number.isFinite(WARP?.MAX_NO_ROUTE) ? WARP.MAX_NO_ROUTE : 20;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const nm = (m) => fmtDistance(m);
const signNm = (m) => `${m >= 0 ? '+' : '−'}${fmtDistance(Math.abs(m))}`;
const MARK_RANK = { approach: 4, patch_exit: 3, tss: 2, canal: 1 };

export class Autopilot {
  constructor(app) {
    this.app = app;
    this.order = null;        // the skipper's last telegraph order (the pilot only ever caps it)
    this.lastWritten = null;  // what the pilot wrote into input.throttleCmd last substep
    this.mode = 'route';      // 'route' | 'berth'
    this.seq = 0; this.inFlight = false; this.lastPlanMs = -Infinity;
    this.lastCheck = 0; this.anchorDistM = Infinity; this.nearestHarbor = null;
    this.legFrom = null; this.session = false; this.cls = null;
    this.stormPlanned = new Map(); this.sailWarned = false; this.staleMeta = null;
  }
  get C() { return SHIP_CLASSES[this.app.ship?.cls || this.app.you?.ship?.cls] || SHIP_CLASSES.coaster; }

  /** P: autopilot on / off. On: steer the route; off: leave the throttle where it is. */
  engage(on) {
    const a = this.app;
    if (on) {
      if (!a.route.length) { a.hud.event({ kind: 'warn', text: 'Set a waypoint or a route on the chart (M) first.' }); return false; }
      a.autopilot = true; a.input.rudderHold = false;
      this.startSession();
      // bought another ship since the route was planned: plan it again for this hull
      const cls = a.you?.ship?.cls;
      const m = a.routeMeta && a.routeMeta.cls && cls && a.routeMeta.cls !== cls ? a.routeMeta : this.staleMeta;
      this.staleMeta = null;
      if (m) { a.routeMeta = null; this.planTo({ ...m.dest, via: this.remainingVia(m), label: m.label, reason: 'class' }); }
      return true;
    }
    a.autopilot = false;
    this.session = false;
    if (a.warp > WARP_MAX_NO_ROUTE) a.setWarp(WARP_MAX_NO_ROUTE, `Autopilot off — time warp back to ${WARP_MAX_NO_ROUTE}× (higher levels sail the route).`);
    return true;
  }
  startSession() {
    const a = this.app;
    // a re-plan while the pilot already steers keeps the skipper's order (input.throttleCmd holds the pilot's capped
    // value inside the harbour bands; adopting it would leave her crawling once she is 5 km out)
    const keep = this.session && Number.isFinite(this.order);
    this.session = true; this.mode = 'route'; this.sailWarned = false;
    if (!keep) { this.lastWritten = null; this.order = Number.isFinite(a.input.throttleCmd) ? a.input.throttleCmd : 0; }
    if (!this.legFrom && a.ship) this.legFrom = { lat: a.ship.lat, lon: a.ship.lon };
  }
  /** Route cleared / docked / tugs / ashore: forget the plan state; answers still in flight are discarded. */
  clear() {
    this.seq++; this.inFlight = false; this.mode = 'route'; this.session = false; this.legFrom = null; this.lastWritten = null; this.staleMeta = null;
    this.app.hud?.clearAlert?.('pilot');
  }

  // ---------------------------------------------------------------------------------------------- planning
  remainingVia(meta = this.app.routeMeta) {
    const via = meta?.via || [];
    const left = new Set(this.app.route.filter((p) => Number.isInteger(p.wp)).map((p) => p.wp));
    return via.filter((_, k) => left.has(k));
  }
  /**
   * Plan a route to a point / harbour (job Route button, trade plans, re-plans). → Promise<{ ok, distM, warnings }>.
   * opts: via (user waypoints), avoid (storm discs), reason ('shoal' | 'off' | 'storm' | 'class'), engage, label.
   */
  async planTo({ lat, lon, harbor = null, label = '', via = [], avoid = null, reason = null, engage = null, shoal = null, storm = null } = {}) {
    const a = this.app, s = a.ship, cls = a.you?.ship?.cls || s?.cls;
    if (!s || !Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, distM: 0, warnings: [] };
    const seq = ++this.seq;
    this.inFlight = true; this.lastPlanMs = performance.now();
    const oldLen = a.route.length ? a.routeLength() : null;
    const q = [`from=${s.lat.toFixed(5)},${s.lon.toFixed(5)}`, `to=${lat.toFixed(5)},${lon.toFixed(5)}`];
    if (cls) q.push(`cls=${encodeURIComponent(cls)}`);
    if (harbor) q.push(`harbor=${encodeURIComponent(harbor)}`);
    if (via.length) q.push(`wp=${via.slice(0, 50).map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(';')}`);
    if (avoid?.length) q.push(`avoid=${avoid.slice(0, 8).map((d) => `${d.lat.toFixed(3)},${d.lon.toFixed(3)},${clamp(Math.round(d.radiusKm), 1, 600)}${d.name ? ',' + encodeURIComponent(String(d.name).replace(/[,;]/g, ' ')) : ''}`).join(';')}`);
    let r = null, status = 0;
    try {
      const res = await fetch(`/api/route?${q.join('&')}`);
      status = res.status;
      if (res.ok) r = await res.json();
    } catch { r = null; }
    if (seq !== this.seq) return { ok: false, stale: true, distM: 0, warnings: [] }; // a newer request (or a clear) owns the route now
    this.inFlight = false;
    if (!r || !Array.isArray(r.points) || !r.points.length) {
      if (reason) return { ok: false, distM: 0, warnings: [], status }; // re-plan failed: keep the route we have
      const pts = [...via, { lat, lon }];
      a.setRoute(pts);
      a.hud.event({ kind: 'warn', text: status === 404 ? 'No sea route found for your ship — sailing straight legs. Watch the depth.' : 'Route planner unreachable — sailing straight legs. Watch the depth.' });
      if (engage) this.engage(true);
      return { ok: false, distM: 0, warnings: [], status };
    }
    // points with their marks (the strongest mark wins on a shared point) and the user waypoint each leg ends at
    const markAt = new Map();
    for (const m of r.marks || []) { const cur = markAt.get(m.i); if (!cur || (MARK_RANK[m.kind] || 0) > (MARK_RANK[cur.kind] || 0)) markAt.set(m.i, m); }
    const wpAt = new Map();
    (r.legs || []).forEach((l, k) => { if (k < via.length) wpAt.set(l.to, k); });
    const pts = r.points.map(([la, lo], i) => {
      const p = { lat: la, lon: lo };
      const m = markAt.get(i); if (m) { p.mark = m.kind; if (m.name) p.name = m.name; }
      if (wpAt.has(i)) p.wp = wpAt.get(i);
      return p;
    });
    const warnings = (r.warnings || []).map((w) => ({ ...w, lat: pts[Math.min(pts.length - 1, Math.max(0, w.i))]?.lat, lon: pts[Math.min(pts.length - 1, Math.max(0, w.i))]?.lon }));
    const marks = (r.marks || []).map((m) => ({ ...m, lat: pts[m.i]?.lat, lon: pts[m.i]?.lon }));
    // a storm re-plan that cannot get round: keep the route we have and say so
    if (reason === 'storm' && storm && warnings.some((w) => w.kind === 'storm_unavoidable')) {
      a.hud.event({ kind: 'warn', text: `Storm ${storm.name || ''} lies across the route ${nm(storm.distM)} ahead and there is no way round — heave to, ride it out or turn back.`.replace('Storm  ', 'A storm ') });
      return { ok: false, distM: r.distM, warnings };
    }
    a.setRoute(pts, { planned: true });
    a.routeMeta = { v: 2, dest: { lat, lon, harbor }, distM: r.distM, draft: r.draft, ukcM: r.ukcM, minDepthM: r.minDepthM, warnings, marks, approach: r.approach || null, plannedAt: Date.now(), label, via: via.map((p) => ({ lat: p.lat, lon: p.lon })), cls, via0: r.via };
    this.legFrom = { lat: s.lat, lon: s.lon }; this.mode = 'route';
    a.routeFlashUntil = performance.now() + 2000;
    a.hud.chart?.requestDraw?.();
    // what the skipper is told
    const tss = marks.find((m) => m.kind === 'tss');
    const toH = r.approach?.harbor ? a.world.harbors.find((h) => h.id === r.approach.harbor) : null;
    if (reason === 'shoal' && shoal) a.hud.event({ kind: 'info', text: `Re-planned: shallows ${shoal.depthM.toFixed(1)} m (you need ${shoal.needM.toFixed(1)} m) ${nm(shoal.distM)} ahead — new route ${nm(r.distM)}${oldLen != null ? ` (${signNm(r.distM - oldLen)})` : ''}.` });
    else if (reason === 'storm' && storm) a.hud.event({ kind: 'info', text: `Re-planned round storm ${storm.name || ''} (${nm(storm.distM)} ahead): new route ${nm(r.distM)}${oldLen != null ? ` (${signNm(r.distM - oldLen)})` : ''}.`.replace('storm  (', 'the storm (') });
    else if (reason === 'off') a.hud.event({ kind: 'info', text: `Off the planned route — re-planned from here: ${nm(r.distM)}${toH ? ` to the approach off ${toH.name.split(' (')[0]}` : ''}.` });
    else {
      const draftTxt = r.draft > 0 ? `for your ${r.draft} m draught` : 'over water';
      const viaTxt = tss ? ` via ${tss.place || 'the TSS'} (${tss.name})` : '';
      const endTxt = toH ? ` to the approach off ${toH.name.split(' (')[0]}` : '';
      a.hud.event({ kind: 'info', text: `Route planned ${draftTxt}: ${nm(r.distM)}${viaTxt}, ${pts.length} waypoint${pts.length > 1 ? 's' : ''}${endTxt}. ${engage || a.autopilot ? 'Autopilot steering.' : 'Press P for autopilot.'}` });
    }
    for (const w of warnings) if (!(reason && w.kind === 'storm_unavoidable')) a.hud.event({ kind: 'warn', text: `⚠ ${w.text}` });
    if (engage && !a.autopilot) this.engage(true);
    else if (a.autopilot) this.startSession();
    return { ok: true, distM: r.distM, warnings };
  }
  /** Chart "Sail route": the plotted points become user waypoints of a planned route to the last one. */
  planVia(points, { label = 'chart route' } = {}) {
    const pts = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!pts.length) return Promise.resolve({ ok: false, distM: 0, warnings: [] });
    const last = pts[pts.length - 1];
    this.app.hud.event({ kind: 'info', text: `Planning the route over ${pts.length} waypoint${pts.length > 1 ? 's' : ''} for your draught…` });
    return this.planTo({ lat: last.lat, lon: last.lon, via: pts.slice(0, -1), label, engage: true });
  }

  // ---------------------------------------------------------------------------------------------- steering
  /** Per simulation substep: steer + speed. false = the route is finished (autopilot off). */
  step(s, C) {
    const a = this.app, r = a.route;
    if (!r.length) return false;
    if (!this.session) this.startSession();
    if (this.lastWritten != null && Math.abs(a.input.throttleCmd - this.lastWritten) > 1e-4) this.order = a.input.throttleCmd; // the skipper rang a new order
    if (this.order == null) this.order = a.input.throttleCmd;
    let capKn = speedCapKn(this.anchorDistM);
    if (this.mode === 'berth') {
      const info = a.berthGuide?.info;
      if (!info || !Number.isFinite(info.steer)) { this.stopHere(this.approachStopText()); return false; }
      if (Number.isFinite(info.remaining) && info.remaining <= Math.max(PILOT.STOP_M, 1.5 * C.length)) { this.stopHere(this.berthStopText()); return false; }
      a.input.rudderCmd = s.spd < -0.3 ? 0 : clamp(angleDiff(s.hdg, info.steer) / 25, -1, 1);
      if (Number.isFinite(info.adv?.maxKn)) capKn = Math.min(capKn, info.adv.maxKn);
      this.writeThrottle(capKn, C, s.spd); // on the berth line she is braked down to the pilot's advice
      return true;
    }
    const wp = r[0];
    const brg = bearing(s.lat, s.lon, wp.lat, wp.lon);
    a.input.rudderCmd = s.spd < -0.3 ? 0 : clamp(angleDiff(s.hdg, brg) / 25, -1, 1); // going astern the rudder works backwards: amidships
    this.writeThrottle(capKn, C);
    const d = haversine(s.lat, s.lon, wp.lat, wp.lon);
    const reach = r.length > 1 ? Math.max(300, C.length * 3) : Math.max(200, C.length * 2);
    if (r.length === 1 && wp.mark === 'approach') {
      // the approach point: hand over to the berth line, or stop here
      const step = handoverStep({ remainingToApproachM: d, L: C.length, guideReady: this.guideReady(), guideRemainingM: a.berthGuide?.info?.remaining ?? null, mode: 'route' });
      if (step === 'berth') { this.toBerth(); return true; }
      if (step === 'stop') { this.stopHere(this.approachStopText()); return false; }
      return true;
    }
    if (d >= reach) return true;
    this.legFrom = r.shift();
    if (r.length) { a.hud.event({ kind: 'info', text: `Waypoint reached, ${r.length} to go.` }); return true; }
    a.autopilot = false; a.input.rudderCmd = 0; this.session = false;
    a.hud.event({ kind: 'info', text: 'Route complete — waypoint reached.' });
    a.routeMeta = null;
    a.hud.chart?.clearRoute?.(true);
    if (a.warp > 1) a.setWarp(1, 'Destination reached — time warp off.');
    return false;
  }
  writeThrottle(capKn, C, brakeSpd = null) {
    const a = this.app;
    let thr = Math.min(this.order, throttleCap(capKn, C.maxKn));
    if (brakeSpd != null && Number.isFinite(capKn)) { // too fast for the berth: engine stopped, then slow astern
      const excess = brakeSpd - capKn;
      if (excess > 1.5) thr = Math.min(thr, -0.2); else if (excess > 0.4) thr = Math.min(thr, 0);
    }
    if (Math.abs((a.input.throttleCmd ?? 0) - thr) > 1e-4) { a.input.throttleCmd = thr; if (this.lastWritten == null || Math.abs(this.lastWritten - thr) > 0.01) a.touchHelm?.setThrottle?.(thr); }
    this.lastWritten = thr;
  }
  guideReady() {
    const g = this.app.berthGuide, nb = this.app.you?.nearBerth;
    if (!g?.plan?.ok || !g.info || !nb || nb.fits === false) return false;
    try { return typeof g.wants === 'function' ? !!g.wants(nb) : true; } catch { return false; }
  }
  toBerth() {
    const a = this.app, nb = a.you?.nearBerth;
    this.mode = 'berth';
    a.hud.event({ kind: 'info', text: `Approach reached — the autopilot follows the berth line to ${nb?.name || 'the berth'} and slows down.` });
  }
  berthStopText() {
    const a = this.app, nb = a.you?.nearBerth;
    return `Off ${nb?.name || 'the berth'}: engines stopped — moor (${a.hud?.touch ? 'tap Moor' : 'T'}) under 2 kn, or call tugs (N).`;
  }
  approachStopText() {
    const a = this.app, m = a.routeMeta, h = m?.dest?.harbor ? a.world.harbors.find((x) => x.id === m.dest.harbor) : this.nearestHarbor;
    return `Harbour approach reached${h ? ` off ${h.name.split(' (')[0]}` : ''} — the autopilot stops here. Follow the berth guidance in or call tugs (N).`;
  }
  /** Order STOP, autopilot off, route cleared, with an event. */
  stopHere(text, kind = 'info') {
    const a = this.app;
    a.input.throttleCmd = 0; a.input.rudderCmd = 0; this.order = 0; this.lastWritten = 0;
    a.touchHelm?.setThrottle?.(0);
    a.clearRoute(); // autopilot off, routeMeta null, chart cleared, warp above 20× dropped
    if (a.warp > 1) a.setWarp(1, null);
    a.hud.event({ kind, text });
    a.sound?.ui?.('click');
  }

  // ---------------------------------------------------------------------------------------------- watch keeping
  /** Per HUD tick: speed band, hand-over, look-ahead for shallows, off-route and storm checks (every CHECK_MS). */
  update(nowMs) {
    const a = this.app, s = a.ship, you = a.you;
    if (!s || !you) return;
    if (!a.autopilot) { this.session = false; if (this.mode === 'berth') this.mode = 'route'; }
    const cls = you.ship?.cls;
    if (this.cls && cls && cls !== this.cls && a.routeMeta) { this.staleMeta = a.routeMeta; a.routeMeta = null; } // bought a ship: the plan was for the old hull (the next engage re-plans it)
    this.cls = cls;
    const now = Number.isFinite(nowMs) ? nowMs : performance.now();
    if (now - this.lastCheck < PILOT.CHECK_MS) return;
    this.lastCheck = now;
    // nearest harbour anchor → speed band
    let best = Infinity, bh = null;
    for (const h of a.world.harbors || []) { if (Math.abs(h.lat - s.lat) > 0.2) continue; const an = a.harborAnchor(h); const d = haversine(s.lat, s.lon, an.lat, an.lon); if (d < best) { best = d; bh = h; } }
    this.anchorDistM = best; this.nearestHarbor = bh;
    if (!a.autopilot || !a.route.length || you.docked || you.assist) return;
    const C = this.C;
    // under sail the telegraph cannot slow her
    if (C.sail && you.sailsUp !== false && Number.isFinite(speedCapKn(best))) {
      if (!this.sailWarned) { this.sailWarned = true; a.hud.event({ kind: 'warn', text: 'Furl the sails for the harbour approach — the autopilot cannot slow a ship under sail.' }); }
    }
    // berth mode: stop off the berth
    if (this.mode === 'berth') {
      const info = a.berthGuide?.info;
      const step = handoverStep({ L: C.length, guideReady: this.guideReady() || !!info, guideRemainingM: info?.remaining ?? null, mode: 'berth' });
      if (step === 'stop') this.stopHere(info ? this.berthStopText() : this.approachStopText());
      return;
    }
    // route mode, last point an approach mark: hand over within max(400 m, 3 L)
    const last = a.route[a.route.length - 1];
    if (last.mark === 'approach') {
      const rem = a.routeLength();
      const step = handoverStep({ remainingToApproachM: rem, L: C.length, guideReady: this.guideReady(), guideRemainingM: a.berthGuide?.info?.remaining ?? null, mode: 'route' });
      if (step === 'berth') { this.toBerth(); return; }
      if (step === 'stop') { this.stopHere(this.approachStopText()); return; }
    }
    if (!a.routeMeta) return; // a raw waypoint: no live re-planning
    const L = C.length, meta = a.routeMeta;
    const state = { lastPlanMs: this.lastPlanMs, inFlight: this.inFlight };
    // shallows ahead (the loaded terrain incl. harbour patches + the tide now — what the keel check uses)
    const need = C.draft + PILOT.UKC_LIVE_M;
    const look = lookAheadM(s.spd, a.warp);
    const depthFn = (lat, lon) => { const h = a.terrain.heightAt(lat, lon); return h == null ? null : -h + (a.tideLevel || 0); };
    let shoal = firstShoal(s, a.route, look, depthFn, need);
    if (shoal && haversine(shoal.lat, shoal.lon, last.lat, last.lon) < 300) shoal = null; // at the destination itself
    const legPts = [this.legFrom || { lat: s.lat, lon: s.lon }, ...a.route];
    const offM = offRouteM(s, legPts);
    if ((shoal || offM > Math.max(PILOT.OFF_ROUTE_M, 5 * L)) && shouldReplan(state, now, { shoal, offM, L })) {
      const sh = shoal ? { ...shoal, needM: need } : null;
      this.planTo({ ...meta.dest, via: this.remainingVia(meta), label: meta.label, reason: shoal ? 'shoal' : 'off', shoal: sh }).then((res) => {
        if (!sh || res.stale) return;
        // still into the same shallows, or no way round while they are close: stop and hand the helm back
        const again = res.ok ? firstShoal(a.ship, a.route, look, depthFn, need) : null;
        const blocked = res.ok ? !!(again && haversine(again.lat, again.lon, sh.lat, sh.lon) < 300) : sh.distM < 1.5 * look;
        if (blocked && a.autopilot) {
          this.stopHere('Autopilot stopped: shallows ahead and no way round found — take the helm.', 'warn');
          a.hud.alert?.('pilot', 'Autopilot stopped: shallows ahead — take the helm', 'warn');
          setTimeout(() => a.hud.clearAlert?.('pilot'), 15000);
        }
      });
      return;
    }
    // storm cells across the route ahead
    const storms = a.storms || [];
    if (storms.length) {
      const sogMh = Math.abs(s.spd) * 1852;
      const hit = stormOnRoute(s, a.route, storms, { horizonM: Math.max(PILOT.STORM_HORIZON_MIN_M, PILOT.STORM_HORIZON_H * sogMh) });
      if (hit) {
        const key = hit.storm.id ?? hit.storm.name ?? 'storm';
        const prev = this.stormPlanned.get(key);
        if (!(prev && now - prev < PILOT.STORM_REPLAN_MS)) {
          const inside = haversine(s.lat, s.lon, hit.storm.lat, hit.storm.lon) < hit.storm.radiusKm * 1000;
          if (inside) {
            this.stormPlanned.set(key, now);
            a.hud.event({ kind: 'warn', text: `Storm ${hit.storm.name || ''} lies across the route ${nm(hit.distM)} ahead and there is no way round — heave to, ride it out or turn back.` });
          } else if (shouldReplan(state, now, { storm: true })) {
            this.stormPlanned.set(key, now);
            const avoid = storms.filter((c) => (Number(c.intensity) || 0) >= PILOT.STORM_MIN && haversine(s.lat, s.lon, c.lat, c.lon) < 1000000).slice(0, 8)
              .map((c) => ({ lat: c.lat, lon: c.lon, radiusKm: c.radiusKm, name: c.name }));
            this.planTo({ ...meta.dest, via: this.remainingVia(meta), label: meta.label, avoid, reason: 'storm', storm: { name: hit.storm.name, distM: hit.distM } });
          }
        }
      }
    }
  }
}
