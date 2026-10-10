// Hostile AI ships (pirates and navy): constants and pure rules shared by the server (authority), the client (labels,
// warnings) and the tests. Contract: docs/HOSTILE-AI-CONTRACT.md. No I/O, no randomness of its own: every roll comes in.
import { SHIP_CLASSES } from './constants.js';

export const HOSTILE = {
  // caps and anti-grief (R3)
  MAX_PER_PLAYER: 3, MAX_GLOBAL: 12, MAX_ATTACKS_PER_DAY: 3,
  ENCOUNTER_GAP_S: 1200,          // quiet time after an encounter ends
  RESPAWN_COOLDOWN_S: 7200,       // after a rescue landing / forced reset
  SPAWN_CHECK_S: 20,              // sim seconds between spawn rolls per skipper
  MAX_WARP_SPAWN: 5,
  HARBOUR_CLEAR_M: 4000,          // never spawn (or attack) this close to a harbour anchor
  NEAR_AREA_KM: 30,               // "near" a danger area
  DESPAWN_M: 25000,
  // spawn rates
  PIRACY_K: 40,                   // encounters per hour = area.p100 × K × prey score (game rule)
  NAVY_RATE_H: { 3: 0.25, 4: 0.5 },   // patrol sightings per hour by area tier
  NAVY_GROUNDS_MUL: 3,
  // pirates
  PIRATE_KN: 32, PIRATE_GIVEUP_KN: 22, PIRATE_MAX_CHASE_S: 1200, PIRATE_STORM: 0.75,
  SPAWN_DIST_M: [3000, 7000],
  DETECT_DAY_M: 9000, DETECT_NIGHT_M: 3500, IDENT_DAY_M: 2500, IDENT_NIGHT_M: 900,
  BOARD_MAX_KN: 13, BOARD_ALONGSIDE_M: 90, BOARD_S: 45, COMPLY_S: 12,
  GUARD_REPEL: 0.8, HIJACK_CARGO_LOSS: 0.3, CARGO_HANDOVER: 0.4,
  RANSOM_FRAC: 0.03, RANSOM_MIN: 2500,
  HOSE_USES: 3, HOSE_GAP_S: 45, CITADEL_MAX_S: 900,
  // navy
  HAIL_M: 6000, HEAVE_TO_S: 90, WARN_GAP_S: 20, INSPECT_S: 45, HEAVE_TO_KN: 2,
  FINE_MIN: 3000, FINE_MULT: 2, DETAIN_H: [2, 6],
  ESCORT_S: 900, NAVY_CALL_GAP_S: 600, NAVY_CALL_DIST_M: 8000, FLEE_M: 7000,
  LEAVE_S: 90, SINK_S: 14,   // seconds a shot-up ship takes to go down in view
};

/** Chance that a friendly anti-piracy patrol answers a call in a piracy area (game numbers, not facts). */
export const NAVY_PRESENCE = { 'piracy-somali-basin': 0.7, 'piracy-sgstrait': 0.6, 'piracy-gog': 0.35 };
export const NAVY_PRESENCE_DEFAULT = 0.3;

/** Unit kinds. `faction` is 'pirate' or 'navy'; navy units take role 'hostile' | 'friend' from their encounter. */
export const KINDS = {
  skiff: { faction: 'pirate', name: 'Pirate skiff', unk: 'Unknown fast craft', kn: 32, turn: 40, len: 9, beam: 2.4, weapon: 'small_arms' },
  patrol: { faction: 'navy', name: 'Naval patrol', unk: 'Unknown fast craft', kn: 34, turn: 24, len: 24, beam: 5.5, weapon: 'gun_30' },
  corvette: { faction: 'navy', name: 'Naval corvette', unk: 'Unknown warship', kn: 26, turn: 12, len: 70, beam: 10, weapon: 'gun_76' },
  rib: { faction: 'navy', name: 'Naval boarding boat', unk: 'Unknown fast craft', kn: 30, turn: 45, len: 7.5, beam: 2.4, weapon: 'warning' },
  frigate: { faction: 'navy', name: 'Naval frigate', unk: 'Unknown warship', kn: 28, turn: 9, len: 110, beam: 14, weapon: 'gun_127' },
};
// Made-up hull names (no real units, no flag, no country).
export const NAVY_NAMES = ['Vigilant', 'Sentinel', 'Bulwark', 'Corsair Hunter', 'Meridian', 'Halberd', 'Tern', 'Albatross', 'Kestrel', 'Northwind'];

/** Weapons: reach (m), seconds between volleys, base hit chance, hull points per hit [min, max] (R10). */
export const WEAPONS = {
  small_arms: { rangeM: 500, volleyS: 8, hit: 0.5, dmg: [0.1, 0.4] },
  warning: { rangeM: 6000, volleyS: 8, hit: 0, dmg: [0, 0] },
  gun_30: { rangeM: 3500, volleyS: 7, hit: 0.7, dmg: [1.5, 3.5] },
  gun_76: { rangeM: 6000, volleyS: 8, hit: 0.7, dmg: [3, 7] },
  gun_127: { rangeM: 9000, volleyS: 10, hit: 0.75, dmg: [6, 12] },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** "YYYY-MM-DD" of a sim time (the per-day attack counter key). */
export function dayKey(simTime) { return new Date(simTime * 1000).toISOString().slice(0, 10); }

/** Crude night test from the sun's mean hour at a longitude (good enough for a detection range). */
export function isNight(lat, lon, simTime) {
  const h = (((simTime / 3600) % 24) + lon / 15 + 24) % 24;
  return Math.abs(lat) <= 66 && (h < 6 || h >= 19);   // polar summer/winter: no cut-off
}

/** Range (m) at which a hostile unit notices a ship: day / night, cut by poor visibility (0..1 weather factor). */
export function detectRangeM(night, visFrac = 1) {
  return Math.round((night ? HOSTILE.DETECT_NIGHT_M : HOSTILE.DETECT_DAY_M) * clamp(visFrac, 0.35, 1));
}
export function identRangeM(night) { return night ? HOSTILE.IDENT_NIGHT_M : HOSTILE.IDENT_DAY_M; }

/**
 * How attractive a ship is to pirates, 0..1: slow, laden, unescorted, unguarded ships score high; a ship at or above
 * HOSTILE.PIRATE_GIVEUP_KN scores 0 (they cannot catch her). Inputs: { spd (kn), loadFrac 0..1, length (m), escorted, guards }.
 */
export function preyScore({ spd = 0, loadFrac = 0, length = 90, escorted = false, guards = false } = {}) {
  const kn = Math.abs(spd);
  if (kn >= HOSTILE.PIRATE_GIVEUP_KN) return 0;
  let s = 0.35 + 0.35 * clamp(1 - kn / HOSTILE.PIRATE_GIVEUP_KN, 0, 1) + 0.3 * clamp(loadFrac, 0, 1);   // slow and heavy = low freeboard
  if (length > 220) s *= 0.6;       // very tall ships are a harder climb
  if (escorted) s *= 0.5;
  if (guards) s *= 0.2;
  return Math.round(clamp(s, 0, 1) * 1000) / 1000;
}

/** Pirate encounters per hour for an area at a given prey score. */
export function pirateRatePerH(area, prey) { return (area?.p100 || 0) * HOSTILE.PIRACY_K * prey; }
/** Navy patrol sightings per hour in a war_risk area (tier ≥ 3), tripled when the ship carries grounds for a check. */
export function navyRatePerH(area, grounds) {
  const r = HOSTILE.NAVY_RATE_H[area?.tier] || 0;
  return r * (grounds ? HOSTILE.NAVY_GROUNDS_MUL : 1);
}
/** Probability that an event with rate `perH` happens within `dtS` seconds. */
export function rollP(perH, dtS) { return 1 - Math.exp(-Math.max(0, perH) * dtS / 3600); }

/** Group size 1..3 from a uniform roll (bigger, more laden ships attract bigger groups). */
export function groupSize(roll, prey) { return roll < 0.45 ? 1 : roll < 0.85 - 0.1 * prey ? 2 : 3; }

/**
 * Hull points one volley takes off: 0 on a miss. `roll` and `hitRoll` are uniform [0,1). Range beyond the weapon's reach
 * never hits. Bigger hulls absorb more: factor sqrt(3200 / displacement) in 0.35..1.6 (the 3,200 t coaster = 1).
 */
export function damageFor(weapon, rangeM, roll, hitRoll, displacement = 3200) {
  const w = WEAPONS[weapon]; if (!w || !(w.hit > 0) || rangeM > w.rangeM) return 0;
  const p = w.hit * (1 - 0.6 * clamp(rangeM / w.rangeM, 0, 1));
  if (hitRoll >= p) return 0;
  const size = clamp(Math.sqrt(3200 / Math.max(1, displacement)), 0.35, 1.6);
  return Math.round((w.dmg[0] + (w.dmg[1] - w.dmg[0]) * clamp(roll, 0, 1)) * size * 100) / 100;
}
export function sizeFactorOf(cls) { return (SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).displacement; }

/** Release payment that ends a pirate attack, from the hull value. */
export function ransomFor(hullVal) { return Math.max(HOSTILE.RANSOM_MIN, Math.round(HOSTILE.RANSOM_FRAC * hullVal)); }

/** Names as the player sees them: unidentified craft stay anonymous. */
export function labelOf(unit) {
  const K = KINDS[unit.k] || KINDS.skiff;
  if (!unit.ident) return K.unk;
  if (K.faction === 'pirate') return K.name;
  return unit.role === 'friend' ? 'Anti-piracy patrol' : K.name;
}

/** Fixed texts the banner and the log use (crews are always safe, R15). */
export const HOSTILE_TEXT = {
  riskOn: 'Risk mode ON: pirates and naval patrols can appear and attack in or near piracy and war-risk areas. Your crew stays safe, but your hull, cargo and ship can be lost.',
  riskOff: 'Risk mode OFF: nothing attacks you. Piracy and war risk stay dice rolls with text events.',
  warn: 'Risk mode is on. In or near piracy areas, small fast craft may chase and try to board you (slow, heavily laden ships are the favourite targets). In war-risk areas naval patrols may stop and search you, and fire on a ship that carries banned cargo and ignores warnings. A hand-sailed ship at 0 % hull sinks with its cargo; the crew is picked up and landed at the nearest harbour.',
};
