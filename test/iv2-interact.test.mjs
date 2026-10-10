// Interiors v2 — interactions (docs/INTERIORS-V2-CONTRACT.md §7, Lane I) with a fake app: telegraph → helm mode,
// radio → vhf.open(true), gmdss → channel 16, ecr → engine panel numbers, ladder climb ends at `to` in 1.5 ± 0.1 s
// (and a movement key cancels it), door animator, peek enter / exit restores the walker, engNear for the sound mix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`const ROOT=${JSON.stringify(ROOT)};export async function resolve(s,c,n){if(s.startsWith('/shared/'))return n(ROOT+s.slice(1),c);if(s.startsWith('/js/'))return n(ROOT+'public'+s,c);return n(s,c);}`));
const { iv2Interact, iv2Leave, iv2Frame } = await import('../public/js/iv2interact.js');
const { engineReadout } = await import('../public/js/iv2panel.js');

function fakeI(extra = {}) {
  const ev = [], vhf = { opened: null, ch: null, open(b) { this.opened = b; }, setChannel(c) { this.ch = c; } };
  const I = {
    plan: { v: 2, emitters: [{ kind: 'me', x: 0, y: 0, z: 0 }], props: [] }, keys: new Set(), y: 0, yaw: 0, pitch: 0, st: { x: 5, z: 5 },
    pos: { x: 5, y: 0, z: 5, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    placeAt(p) { this.st = { x: p.x, z: p.z }; this.pos.set(p.x, p.y, p.z); this.y = p.y; if (p.yaw != null) this.yaw = p.yaw; this.placed = p; },
    unlock() { this.unlocked = true; },
    app: { hud: { event: (e) => ev.push(e) }, vhf, sound: { footstep() {}, event() {} }, you: { fuel: 80, cond: 90, ship: { throttle: 0.5 } } },
    ...extra,
  };
  return { I, ev, vhf };
}

test('interact: telegraph puts the walker in helm mode at the telegraph', () => {
  const { I, ev } = fakeI();
  assert.equal(iv2Interact(I, { kind: 'telegraph', x: 1, y: 20, z: 2, label: 'Telegraph' }), true);
  assert.equal(I.atHelm, true); assert.equal(I.station.kind, 'telegraph');
  assert.deepEqual([I.pos.x, I.pos.y, I.pos.z], [1, 20, 2]);
  assert.ok(ev.length === 1 && /telegraph/i.test(ev[0].text));
});

test('interact: radio opens the VHF, GMDSS on channel 16; without a VHF the v1 path handles it', () => {
  let f = fakeI();
  assert.equal(iv2Interact(f.I, { kind: 'radio' }), true); assert.equal(f.vhf.opened, true); assert.ok(f.I.unlocked);
  f = fakeI();
  assert.equal(iv2Interact(f.I, { kind: 'gmdss' }), true); assert.equal(f.vhf.ch, 16); assert.equal(f.vhf.opened, true);
  f = fakeI(); f.I.app.vhf = null;
  assert.equal(iv2Interact(f.I, { kind: 'radio' }), false);
  assert.equal(iv2Interact(f.I, { kind: 'something_else' }), false);
});

test('interact: ECR opens the engine panel; its readout follows the throttle, fuel and flooding', () => {
  const { I } = fakeI();
  assert.equal(iv2Interact(I, { kind: 'ecr', label: 'Engine control room' }), true);
  const plan = { iv2: { me: { kind: '2s' } }, props: [{ t: 'generator' }, { t: 'generator' }, { t: 'generator' }] };
  const r = engineReadout(I.app, plan);
  assert.ok(r.rpm > 0 && r.rpm <= 110, `rpm ${r.rpm}`); assert.equal(r.astern, false); assert.equal(r.gens, 3);
  assert.deepEqual(r.alarms, []);
  const dry = engineReadout({ you: { fuelEmpty: true, fuel: 0, cond: 20, flooding: 0.3, ship: { throttle: -0.5 } } }, plan);
  assert.equal(dry.rpm === 0 || Object.is(dry.rpm, -0), true);
  assert.ok(dry.alarms.some((a) => /NO FUEL/.test(a)) && dry.alarms.some((a) => /Bilge/.test(a)) && dry.alarms.some((a) => /Hull/.test(a)));
  const four = engineReadout(I.app, { iv2: { me: { kind: '4s' } }, props: [] });
  assert.ok(four.rpm > 110, 'medium-speed rpm');
});

test('interact: wing / aft stations — helm mode looking along the side or aft', () => {
  const { I } = fakeI();
  iv2Interact(I, { kind: 'thrusters', x: 12, y: 20, z: 3, label: 'Starboard wing console' });
  assert.equal(I.station.kind, 'wing'); assert.equal(I.station.side, 1); assert.ok(Math.abs(I.yaw - Math.PI * 0.75) < 1e-9);
  const b = fakeI().I; iv2Interact(b, { kind: 'thrusters', x: 0, y: 20, z: 3, label: 'Aft control station' });
  assert.equal(b.station.kind, 'aft'); assert.ok(Math.abs(b.yaw - Math.PI) < 1e-9);
  b.atHelm = false; iv2Frame(b, 0.016); assert.equal(b.station, null, 'leaving the helm clears the station');
});

test('interact: a ladder climb ends at its top in 1.5 ± 0.1 s; a movement key before half-way turns it back', () => {
  const { I } = fakeI();
  const to = { x: 5, y: 3, z: 6 };
  assert.equal(iv2Interact(I, { kind: 'ladder', x: 5, y: 0, z: 5, to, label: 'Climb up: B deck' }), true);
  let t = 0; while (I.climb && t < 3) { iv2Frame(I, 0.02); t += 0.02; }
  assert.ok(Math.abs(t - 1.5) <= 0.1, `climb took ${t.toFixed(2)} s`);
  assert.deepEqual([I.placed.x, I.placed.y, I.placed.z], [5, 3, 6]);
  const b = fakeI().I;
  iv2Interact(b, { kind: 'ladder', x: 5, y: 0, z: 5, to, label: 'Climb up: B deck' });
  iv2Frame(b, 0.3); b.keys.add('s'); let n = 0; while (b.climb && n++ < 200) iv2Frame(b, 0.02);
  assert.ok(Math.abs(b.placed.y - 0) < 1e-9, `cancelled climb back at the foot (y ${b.placed.y})`);
  assert.equal(iv2Interact(fakeI().I, { kind: 'ladder', x: 0, y: 0, z: 0 }), false, 'no target → not handled');
});

test('interact: door leaves open when the walker is near and close 2 s after; watertight doors are slower', () => {
  const room = { x0: 0, x1: 4, z0: 0, z1: 3, y: 0 };
  const doors = [{ d: { side: 's', at: 2, w: 0.9, kind: 'door' }, a: room, t: 0 }, { d: { side: 'n', at: 1, w: 0.9, kind: 'watertight' }, a: room, t: 0 }];
  const { I } = fakeI({ v2: { doors, setDoor: (dd, t) => { dd.t = t; } } });
  I.pos.set(2, 0, 2.6);   // by the south door
  for (let i = 0; i < 30; i++) iv2Frame(I, 0.02);
  assert.ok(doors[0].t > 0.99, `door open ${doors[0].t}`); assert.equal(doors[1].t, 0, 'far door shut');
  I.pos.set(1, 0, 0.4);   // by the watertight door
  for (let i = 0; i < 30; i++) iv2Frame(I, 0.02);
  assert.ok(doors[1].t > 0.3 && doors[1].t < 0.6, `watertight door half way ${doors[1].t}`);
  I.pos.set(30, 0, 30);
  for (let i = 0; i < 200; i++) iv2Frame(I, 0.02);
  assert.ok(doors[0].t < 0.01 && doors[1].t < 0.01, 'both closed again');
});

test('interact: peek holds the camera and E / Esc puts the walker back; engNear from the main engine', () => {
  const { I } = fakeI({ v2: { doors: [] } });
  I.pos.set(3, 0, 4); I.st = { x: 3, z: 4 }; I.yaw = 0.4; I.pitch = 0.1;
  assert.equal(iv2Interact(I, { kind: 'peek', label: 'Cargo hold 1', pose: { x: 0, y: 10, z: 50 } }), true);
  iv2Frame(I, 0.016); assert.equal(I.pos.z, 50);
  assert.equal(iv2Interact(I, { kind: 'radio' }), true, 'any interaction leaves the peek first');
  assert.equal(I.peek, null); assert.deepEqual([I.placed.x, I.placed.z, I.placed.yaw], [3, 4, 0.4]); assert.equal(I.pitch, 0.1);
  assert.equal(iv2Leave(I), false);
  I.pos.set(3, 0, 0); iv2Frame(I, 0.016);
  assert.ok(I.v2.engNear > 0.7 && I.v2.engNear <= 1, `engNear ${I.v2.engNear}`);
  I.pos.set(30, 0, 0); iv2Frame(I, 0.016); assert.equal(I.v2.engNear, 0);
});

test('interact: v1 plans are left alone', () => {
  const { I } = fakeI(); I.plan = { v: 1 }; I.climb = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 3, z: 0 }, t: 0, dur: 1.5 };
  iv2Frame(I, 0.5); assert.equal(I.climb.t, 0);
});
