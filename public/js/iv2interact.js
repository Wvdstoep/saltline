// Interiors v2 — interactions (docs/INTERIORS-V2-CONTRACT.md §7, Lane I).
//   iv2Interact(I, h) → true when handled (called by interior.js interact() before gaInteract, hook HV4):
//     telegraph   helm mode at the telegraph (W/S give telegraph orders through app.telegraph), E/Esc leaves
//     radio       the VHF panel (app.vhf.open(true)); fallback: chat focus (v1)
//     gmdss       the VHF panel on channel 16 (the DSC distress button stays the panel's guarded control)
//     ecr/engine  the engine panel (iv2panel.js)
//     thrusters   station mode at a wing console / aft station: helm controls, looking along the side or aft
//     ladder      an animated climb (1.5 s), cancelled with a movement key before half-way
//     peek        a look-only camera into a tank / hold / pump room; E/Esc back
//   iv2Frame(I, dt) per frame after the avatar is placed (hook HV3b): ladder climb, door leaves, sill foot-lift,
//     the station camera, engNear for the sound mix.
// Pure state machines (no DOM) except the panel, so the node tests drive them with a fake app.
import { openEnginePanel, closeEnginePanel, panelOpen } from './iv2panel.js';

// cruise venues (docs/CRUISE-CONTRACT.md §7): the panels and mini games live in iv2games.js, fetched when the first one is used
let G = null;
export const gamesOpen = () => !!(G && G.isOpen());
function openVenue(I, h) { (G ? Promise.resolve(G) : import('./iv2games.js').then((m) => (G = m))).then((m) => m.openVenue(I, h)).catch((e) => { console.warn('[iv2games]', e); ev(I, 'The venue is closed.', 'warn'); }); }

const CLIMB_S = 1.5;
const MOVE = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const ev = (I, text, kind = 'info') => I.app?.hud?.event?.({ kind, text });

export function iv2Interact(I, h) {
  const app = I.app || {};
  if (I.peek || panelOpen() || gamesOpen()) { iv2Leave(I); return true; }
  if (typeof h.kind === 'string' && h.kind.startsWith('v:')) { openVenue(I, h); return true; }
  switch (h.kind) {
    case 'telegraph': {
      const p = { x: h.x, y: h.y, z: h.z };
      I.atHelm = true; I.keys?.clear?.(); I.station = { kind: 'telegraph', pose: p };
      I.st = { x: p.x, z: p.z, y: p.y }; I.pos?.set?.(p.x, p.y, p.z); I.y = p.y; I.yaw = 0; I.pitch = -0.05;
      ev(I, 'At the engine telegraph. W/S give the next order ahead / astern (one order at a time), space STOP; E or Esc to step away.');
      return true;
    }
    case 'radio': {
      if (!app.vhf?.open) return false;
      app.vhf.open(true); I.unlock?.();
      ev(I, 'VHF: pick a channel, hold PTT (Z) to talk. Esc closes the radio.');
      return true;
    }
    case 'gmdss': {
      if (!app.vhf?.open) return false;
      app.vhf.setChannel?.(16); app.vhf.open(true); I.unlock?.();
      ev(I, 'GMDSS console: VHF DSC on channel 16, MF/HF and Inmarsat-C. The distress button is guarded on the panel.');
      return true;
    }
    case 'ecr': case 'engine': {
      openEnginePanel(I, h);
      return true;
    }
    case 'thrusters': {
      const side = Math.sign(h.x || 0) || 1, aft = /aft/i.test(h.label || '');
      I.atHelm = true; I.keys?.clear?.();
      I.station = { kind: aft ? 'aft' : 'wing', side, pose: { x: h.x, y: h.y, z: h.z } };
      I.st = { x: h.x, z: h.z, y: h.y }; I.pos?.set?.(h.x, h.y, h.z); I.y = h.y;
      I.yaw = aft ? Math.PI : (side > 0 ? Math.PI * 0.75 : -Math.PI * 0.75); I.pitch = -0.12;
      ev(I, aft ? 'Aft control station: W/S engine, A/D rudder, joystick for the thrusters; E or Esc to step away.' : `Wing console (${side < 0 ? 'port' : 'starboard'}): you look aft along the ship's side. W/S engine, A/D rudder, thrusters on the joystick; E or Esc to step away.`);
      return true;
    }
    case 'ladder': {
      if (!h.to) return false;
      if (I.climb) return true;
      const from = { x: I.st?.x ?? h.x, y: I.y ?? h.y, z: I.st?.z ?? h.z };
      I.climb = { from, to: { ...h.to }, t: 0, dur: CLIMB_S, up: h.to.y > from.y, label: h.label };
      I.keys?.clear?.();
      return true;
    }
    case 'peek': {
      if (!h.pose) return false;
      I.peek = { pose: h.pose, back: { x: I.st.x, y: I.y, z: I.st.z, yaw: I.yaw, pitch: I.pitch } };
      ev(I, `${h.label}. E or Esc to step back.`);
      return true;
    }
    default: return false;
  }
}

/** Leave a station / peek / panel (E or Esc while in one). True when something was left. */
export function iv2Leave(I) {
  if (panelOpen()) { closeEnginePanel(); return true; }
  if (gamesOpen()) { G.close(); return true; }
  if (I.peek) { const b = I.peek.back; I.peek = null; I.placeAt?.({ x: b.x, y: b.y, z: b.z, yaw: b.yaw }); I.pitch = b.pitch; return true; }
  return false;
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** Per frame, after the avatar is placed (HV3b). */
export function iv2Frame(I, dt) {
  if (!I.plan || I.plan.v !== 2) return;
  if (I.station && !I.atHelm) I.station = null;
  // ---- ladder climb: ease along the ladder, hands-on-rungs bob; a movement key before half-way cancels it
  const c = I.climb;
  if (c) {
    c.t += dt / c.dur;
    const moving = [...(I.keys || [])].some((k) => MOVE.has(k)) || !!I.app?.touchHelm?.stick?.active;
    if (moving && c.t < 0.5 && !c.cancel) { c.cancel = true; c.t = 1 - c.t; const f = c.from; c.from = c.to; c.to = f; }
    const t = Math.min(1, c.t), e = ease(t);
    const x = c.from.x + (c.to.x - c.from.x) * e, z = c.from.z + (c.to.z - c.from.z) * e, y = c.from.y + (c.to.y - c.from.y) * e;
    const bob = Math.sin(t * Math.PI * 6) * 0.04;
    I.st = { x, z, y }; I.pos?.set?.(x, y, z); I.y = y;
    if (I.avatar) I.avatar.position.set(x, y + bob, z);
    if (t >= 1) {
      I.climb = null;
      I.placeAt?.({ x: c.to.x, y: c.to.y, z: c.to.z, yaw: I.yaw });
      if (!c.cancel) ev(I, (c.label || '').replace(/^Climb (up|down): ?/, 'You climb $1 — '));
      I.app?.sound?.footstep?.('chequer');
    } else if (Math.floor(c.t * 6) !== Math.floor((c.t - dt / c.dur) * 6)) I.app?.sound?.footstep?.('chequer');
  }
  // ---- doors: leaves swing / slide open when the walker is within 1.2 m and close 2 s after; WT doors warn
  const V = I.v2;
  if (V?.doors?.length) {
    const px = I.pos.x, pz = I.pos.z, py = I.y, now = (I._t = (I._t || 0) + dt);
    for (const dd of V.doors) {
      const d = dd.d, a = dd.a, ns = d.side === 'n' || d.side === 's', c2 = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side];
      const dx = ns ? px - d.at : px - c2, dz = ns ? pz - c2 : pz - d.at;
      const near = Math.abs(py - a.y) < 1.2 && Math.hypot(dx, dz) < 1.2;
      if (near) dd.seen = now;
      const want = near || now - (dd.seen ?? -9) < 2 ? 1 : 0;
      if (Math.abs(want - dd.t) > 1e-3) {
        const sp = d.kind === 'watertight' ? 0.7 : 2.4;
        const t = dd.t + Math.sign(want - dd.t) * Math.min(Math.abs(want - dd.t), dt * sp);
        if (d.kind === 'watertight' && want === 1 && dd.t === 0) { try { I.app?.sound?.event?.('door', 0.4); } catch { /* no such cue */ } }
        V.setDoor ? V.setDoor(dd, t) : (dd.t = t);
      }
    }
    // sill foot-lift: within 0.35 m of a door with a sill the avatar steps over it (visual only, walker unchanged)
    if (I.avatar && !c) {
      let lift = 0;
      for (const dd of V.doors) {
        const d = dd.d, a = dd.a; if (Math.abs(I.y - a.y) > 0.3) continue;
        const sill = d.kind === 'watertight' ? 0.2 : d.kind === 'ext' ? 0.12 : 0.03;
        const ns = d.side === 'n' || d.side === 's', c2 = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side];
        const across = ns ? Math.abs(I.pos.z - c2) : Math.abs(I.pos.x - c2), along = ns ? Math.abs(I.pos.x - d.at) : Math.abs(I.pos.z - d.at);
        if (across < 0.35 && along < d.w / 2) lift = Math.max(lift, sill * (1 - across / 0.35) * 0.9);
      }
      I.avatar.position.y += lift;
    }
  }
  // ---- engNear for the sound mix: 0–1 from the nearest ME / genset emitter (12 m falloff)
  if (V && I.plan.emitters?.length) {
    let best = Infinity;
    for (const e of I.plan.emitters) { if (e.kind !== 'me' && e.kind !== 'genset') continue; const d = Math.hypot(e.x - I.pos.x, (e.y - I.y) * 1.5, e.z - I.pos.z); if (d < best) best = d; }
    V.engNear = Number.isFinite(best) ? Math.max(0, 1 - best / 12) : null;
  }
  // ---- peek: hold the camera at the pose (interior.js places the camera after this; we steer its inputs)
  if (I.peek) { const p = I.peek.pose; I.st = { x: p.x, z: p.z, y: p.y }; I.pos?.set?.(p.x, p.y, p.z); I.y = p.y; }
}
