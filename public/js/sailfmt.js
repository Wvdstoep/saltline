// Saltline sailing HUD — pure formatters, colour zones, slider mapping, advice and the keyboard map
// (docs/SAILING-CONTRACT.md §0.2, §3.3, §5). No DOM, no three.js: node-testable (test/sailviz-hud.test.mjs).
// Advice texts and their priority come from shared/sail/trim.js (adviceFor) — never re-typed here.
import { adviceFor, ADVICE_TEXT } from '../../shared/sail/trim.js';
import { rigOf, sailIds } from '../../shared/sail/rigs.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ------------------------------------------------------------------------------------------------ advice
/** Advice keys in priority order (§3.3; `luff` / `stall` carry `:<sail id>`). */
export const ADVICE_ORDER = ['irons', 'bylee', 'nogo', 'roundup', 'flying', 'heel', 'luff', 'stall', 'reef_out', 'good'];
export const adviceRank = (key) => { const k = String(key || '').split(':')[0]; const i = ADVICE_ORDER.indexOf(k); return i < 0 ? ADVICE_ORDER.length : i; };
/** Severity of an advice key → 'danger' | 'warn' | 'info' | 'good' (the HUD line's colour). */
export function adviceLevel(key) {
  const k = String(key || '').split(':')[0];
  if (k === 'bylee' || k === 'roundup' || k === 'flying' || k === 'irons') return 'danger';
  if (k === 'nogo' || k === 'heel' || k === 'luff' || k === 'stall') return 'warn';
  if (k === 'good') return 'good';
  return 'info';
}
/** The advice line for a rig (shared/sail/trim.js adviceFor) + its level, or null when no sail is set. */
export function adviceOf(cls, rig, opts) {
  const R = rigOf(cls); if (!R || !rig) return null;
  const a = adviceFor(R, rig, opts); if (!a) return null;
  return { ...a, level: adviceLevel(a.key) };
}
export { ADVICE_TEXT };

// ------------------------------------------------------------------------------------------------ states, telltales, zones
export const STATE_NAMES = ['drawing', 'luffing', 'flogging', 'stalled', 'crew working', 'down'];
/** Status dot colour (§5.4): green drawing, amber luffing, red stalled / flogging, blue crew working, grey down. */
export function stateColor(state) { return ['green', 'amber', 'red', 'red', 'blue', 'grey'][clamp(Math.round(num(state, 5)), 0, 5)]; }
/** Telltale codes bottom / middle / top (0 streaming, 1 windward lifting, 2 leeward stalling). */
export function ttCodes(tt) { const t = num(tt, 0) | 0; return [t & 3, (t >> 2) & 3, (t >> 4) & 3]; }
export const TT_TEXT = ['streaming', 'windward lifting — pull in / bear away', 'leeward stalling — ease / head up'];
/** % of target colour (§5.2): green ≥ 95 %, amber 80–95 %, red < 80 %. pct is a fraction (0.97 = 97 %). */
export function pctColor(pct) { const p = num(pct, 0); return p >= 0.95 ? 'green' : p >= 0.8 ? 'amber' : 'red'; }
/** Heel zone (§5.3): green ≤ phiT, amber ≤ phiT + 8, red beyond. */
export function heelZone(heelDeg, phiT) { const h = Math.abs(num(heelDeg)); return h <= phiT ? 'green' : h <= phiT + 8 ? 'amber' : 'red'; }
/** Helm bar zone: |H| ≤ 0.7 green, ≤ 1 amber, > 1 red (rounding up). */
export function helmZone(h) { const a = Math.abs(num(h)); return a <= 0.7 ? 'green' : a <= 1 ? 'amber' : 'red'; }
/** Catamaran hull load zone (HM/RMmax): < 0.56 green, < 0.7 amber, ≥ 0.7 red (windward hull lifting). */
export function loadZone(load) { const l = num(load); return l < 0.56 ? 'green' : l < 0.7 ? 'amber' : 'red'; }

// ------------------------------------------------------------------------------------------------ sliders
export const SLIDER_MAX = 1000;
/** Sheet 0 (hard in, slider left) … 1 (all out, right) ↔ slider integer. */
export const sheetToSlider = (sheet) => Math.round(clamp(num(sheet), 0, 1) * SLIDER_MAX);
export const sliderToSheet = (v) => clamp(num(Number(v)) / SLIDER_MAX, 0, 1);
/** Traveller −1 (windward, left) … +1 (leeward, right) ↔ slider integer. */
export const travToSlider = (trav) => Math.round(((clamp(num(trav), -1, 1) + 1) / 2) * SLIDER_MAX);
export const sliderToTrav = (v) => clamp((num(Number(v)) / SLIDER_MAX) * 2 - 1, -1, 1);
/** Percent position (0…100) of a value on its slider — for the green tick and the good band. */
export const tickPct = (sheet) => clamp(num(sheet), 0, 1) * 100;
/** Keyboard sheet step: Shift = fine. */
export const sheetStep = (fine) => (fine ? 0.01 : 0.05);
export const TRAV_STEP = 0.1;
/** True when a slider move from a to b crossed (or landed on) the optimum o — the phone's light haptic tick. */
export function crossedOptimum(a, b, o) { if (![a, b, o].every(Number.isFinite)) return false; return (a - o) * (b - o) <= 0 && a !== b; }

// ------------------------------------------------------------------------------------------------ labels
/** Tack or jibe for the Z button: |TWA| < 90° → tack (through the wind), else jibe (§0.2). */
export const maneuverFor = (twaDeg) => (Math.abs(num(twaDeg)) < 90 ? 'tack' : 'jibe');
export const maneuverLabel = (twaDeg) => (maneuverFor(twaDeg) === 'tack' ? 'Tack' : 'Jibe');
/** Helper levels cycle Off → Hints → Auto (Shift+Q). */
export const AUTO_LEVELS = ['off', 'hint', 'full'];
export const AUTO_LABEL = { off: 'Off', hint: 'Hints', full: 'Auto' };
export function nextAuto(a) { const i = AUTO_LEVELS.indexOf(a); return AUTO_LEVELS[(i < 0 ? 1 : i + 1) % 3]; }
/** Signed relative wind (deg, −180…180, + = from starboard) from the wind's from-direction and the heading. Fixes the
 *  legacy 0…360 `windRel()` (§1.2 item 1: sails to windward with the wind from port). */
export function windRelSigned(fromDeg, hdgDeg) { let r = ((((num(fromDeg) - num(hdgDeg)) % 360) + 540) % 360) - 180; if (r === -180) r = 180; return r; }
/** "45° S" / "120° P" (wind over the starboard / port side). */
export function fmtSide(deg) { const d = Math.round(num(deg)); return `${Math.abs(d)}°${d === 0 || Math.abs(d) === 180 ? '' : d > 0 ? ' S' : ' P'}`; }
export const fmtKn = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
export const fmtDeg = (v) => (Number.isFinite(v) ? `${String(Math.round(((v % 360) + 360) % 360)).padStart(3, '0')}°` : '—');
export const fmtPct = (p) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '—');
/** VMG to the wind (STW·cos TWA) or VMC to the active waypoint (SOG·cos(COG − brg)) (§5.2). */
export function vmgInfo({ stwKn, sogKn, twaDeg, cogDeg, brgDeg } = {}) {
  if (Number.isFinite(brgDeg) && Number.isFinite(cogDeg)) return { label: 'VMC', kn: num(sogKn) * Math.cos(((cogDeg - brgDeg) * Math.PI) / 180) };
  return { label: 'VMG', kn: num(stwKn) * Math.cos((num(twaDeg) * Math.PI) / 180) };
}
/** Hoist control label for a TrimInfo sail row: furlers get a roll slider (''), others Hoist / Lower. */
export function hoistLabel(row) { if (!row || row.canFurl) return ''; return row.hoist > 0.5 || row.job === 'hoist' ? 'Lower' : 'Hoist'; }
/** "Reef 1/2" or '' for sails without reefs. */
export const reefLabel = (row) => (row && row.reefs > 0 ? `Reef ${row.reef}/${row.reefs}` : '');
/** Crew job progress 0…1 (job seconds left → fraction done) for the button's progress bar. */
export function jobProgress(row, totalS) { if (!row || !row.job || !(totalS > 0)) return 0; return clamp(1 - num(row.work) / totalS, 0, 1); }

// ------------------------------------------------------------------------------------------------ keys (§0.2)
/** Keys the game already uses in main.js keydown (lower-case e.key); `r` only while the chart is open. */
export const GAME_KEYS = ['enter', 'escape', 'g', 'y', 'u', 'i', 'm', 'tab', 'h', 'l', 'o', 't', 'j', 'f', 'k', 'p', 'c', 'x', 'n', '.', ',', '<', '>', 'w', 's', 'a', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'b', 'v'];
export const GAME_KEYS_CHART_ONLY = ['r'];
/** The sail keys (e.key lower-case / e.code) — see keyAction. */
export const SAIL_KEYS = ['q', 'z', 'r', '1', '2', '3', '4', '5', '6', '7', '[', ']', '-', '='];
/**
 * Map a keydown event (or a plain { key, code, shiftKey, ctrlKey, altKey, metaKey }) to a sail action, or null.
 * Digit / bracket / minus / equal use e.code so Shift (which changes e.key to '!' '{' …) still maps.
 * → { type: 'panel' } | { type: 'auto' } | { type: 'select', i } | { type: 'hoist', i } | { type: 'sheet', d, fine }
 *   | { type: 'sheetAll', d } | { type: 'trav', d } | { type: 'reef', d } | { type: 'maneuver' }
 */
export function keyAction(e) {
  if (!e || e.altKey || e.metaKey) return null;
  const key = String(e.key || '').toLowerCase(), code = String(e.code || '');
  const digit = /^Digit([1-7])$/.exec(code) || (/^[1-7]$/.test(key) ? [null, key] : null);
  if (digit && !e.ctrlKey) return e.shiftKey ? { type: 'hoist', i: Number(digit[1]) - 1 } : { type: 'select', i: Number(digit[1]) - 1 };
  const br = code === 'BracketRight' || key === ']' || key === '}', bl = code === 'BracketLeft' || key === '[' || key === '{';
  if (br || bl) { const d = br ? -1 : 1; return e.ctrlKey ? { type: 'sheetAll', d } : { type: 'sheet', d, fine: !!e.shiftKey }; }
  if (e.ctrlKey) return null;
  if (code === 'Equal' || key === '=' || key === '+') return { type: 'trav', d: -1 };    // traveller up = car to windward
  if (code === 'Minus' || key === '-' || key === '_') return { type: 'trav', d: 1 };
  if (key === 'q' || code === 'KeyQ') return e.shiftKey ? { type: 'auto' } : { type: 'panel' };
  if (key === 'r' || code === 'KeyR') return { type: 'reef', d: e.shiftKey ? -1 : 1 };
  if (key === 'z' || code === 'KeyZ') return { type: 'maneuver' };
  return null;
}
/**
 * Turn a key action into a rig command (§3.4) given the TrimInfo and the selected sail index. Pure.
 * → { cmd } (send it), { ui: 'panel' | 'select', i } (HUD only), { maneuver: 'tack' | 'jibe' }, or null.
 */
export function actionToCommand(act, info, sel = 0) {
  if (!act || !info) return null;
  const rows = info.sails || [], row = rows[clamp(sel, 0, Math.max(0, rows.length - 1))];
  switch (act.type) {
    case 'panel': return { ui: 'panel' };
    case 'select': return act.i < rows.length ? { ui: 'select', i: act.i } : null;
    case 'auto': return { cmd: { auto: nextAuto(info.auto) } };
    case 'maneuver': return { maneuver: maneuverFor(info.twa), cmd: { maneuver: maneuverFor(info.twa) } };
    case 'sheet': if (!row) return null; return { cmd: { sails: { [row.id]: { sheet: clamp(row.sheet + act.d * sheetStep(act.fine), 0, 1) } } } };
    case 'sheetAll': { const s = {}; for (const r of rows) if (r.hoist > 0.05) s[r.id] = { sheet: clamp(r.sheet + act.d * 0.05, 0, 1) }; return { cmd: { sails: s } }; }
    case 'trav': if (!row || !row.boom) return null; return { cmd: { sails: { [row.id]: { trav: clamp(row.trav + act.d * TRAV_STEP, -1, 1) } } } };
    case 'reef': if (!row || !(row.reefs > 0)) return null; return { cmd: { sails: { [row.id]: { reef: clamp(row.reef + act.d, 0, row.reefs) } } } };
    case 'hoist': {
      const r = rows[act.i]; if (!r) return null;
      if (r.canFurl) return { cmd: { sails: { [r.id]: { hoist: r.hoist > 0.5 ? 0 : 1 } } } };
      return { cmd: { sails: { [r.id]: { hoist: r.hoist > 0.5 || r.job === 'hoist' ? 0 : 1 } } } };
    }
    default: return null;
  }
}
/** "Trim all": every set sheet (and traveller) to its green tick, once (§0.2). */
export function trimAllCommand(info) {
  const s = {};
  for (const r of (info && info.sails) || []) if (r.hoist > 0.05) { s[r.id] = { sheet: clamp(num(r.sheetOpt, r.sheet), 0, 1) }; if (r.boom && Number.isFinite(r.travOpt)) s[r.id].trav = clamp(r.travOpt, -1, 1); }
  return { sails: s };
}
/** Sail chip labels (front to back) for the phone sheet. */
export function sailChips(cls) { const R = rigOf(cls); return R ? sailIds(cls).map((id, i) => ({ id, i, name: R.byId[id].name, key: String(i + 1) })) : []; }
