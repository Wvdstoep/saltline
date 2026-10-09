// VHF radio — pure formatting for the client panel (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6.6, lane B). DOM-free so Node
// tests import it directly (test/vhf-fmt.test.mjs). The relative imports resolve to /shared/… in the browser.
import { CHANNELS, CH_DSC, PRESETS, bars, garble, effectivePower, stepChannel, isVoice } from '../../shared/vhf.js';
import { render, autoArgs, phrasesFor, PHRASE_LABEL, textOf } from '../../shared/vhfphrases.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Channel display: { num: '16', name, use, dsc, duplex }. */
export function chLabel(ch) {
  const c = CHANNELS[ch];
  if (!c) return { num: String(ch ?? '--'), name: 'Not a marine channel', use: null, dsc: false, duplex: false };
  return { num: String(ch).padStart(2, '0'), name: c.name, use: c.use, dsc: !c.voice, duplex: c.duplex };
}
/** "25 W" | "1 W" | "1 W (inland)"; short: "25W" | "1W" | "1W INL" (the LCD). */
export function powerLabel(radio = {}, short = false) {
  const eff = radio.powerEff || effectivePower(radio.ch, radio.power, !!radio.inland);
  if (eff === 'hi') return short ? '25W' : '25 W';
  const inl = radio.power !== 'lo' && radio.inland;
  return short ? (inl ? '1W INL' : '1W') : inl ? '1 W (inland)' : '1 W';
}
const pad2 = (n) => String(n).padStart(2, '0');
export function clock(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
const KIND_ICON = { player: 'ship', ship: 'ship', bridge: 'bridge', lock: 'lock', vts: 'vts', cg: 'cg', harbour: 'harbour' };

/**
 * One received transmission → a log row. Garbled from q (seeded by the message time + sender, so it is stable).
 * → { key, time, ch, from, fromKind, to, text, q, bars, self, dsc, garbled, op }
 */
export function logEntry(msg, { lang = 'en' } = {}) {
  const raw = textOf(msg, lang);
  const q = msg.self ? 1 : Number(msg.q) || 0;
  const text = garble(raw, q, `${msg.at}:${msg.from?.id}`);
  return {
    key: `${msg.at}:${msg.from?.id}:${msg.ch}`, time: clock(msg.at || Date.now()), ch: msg.ch, from: msg.from?.name || '?', fromKind: msg.from?.kind || 'player',
    icon: KIND_ICON[msg.from?.kind] || 'ship', to: msg.to?.name || null, text, q, bars: bars(q), self: !!msg.self, dsc: msg.ch === CH_DSC ? (msg.dsc || 'distress') : null,
    garbled: q < 0.15 && !msg.self, op: msg.from?.kind && msg.from.kind !== 'player',
  };
}
/** The ship for phrase previews, from the client's `you` (+ optional class info). */
export function youShip(you = {}, info = {}) {
  const s = you.ship || {};
  return {
    name: you.vesselName || you.name || 'You', hdg: s.hdg, lat: s.lat, lon: s.lon,
    ad: you.air?.ad ?? info.ad ?? null, T: you.air?.T ?? info.T ?? null, L: info.L ?? null, B: info.B ?? null, type: info.type || 'ship',
    dest: you.voyage?.toName || null, where: info.where || 'approach',
  };
}
/** The text the player is about to send (preview), same renderer the receivers use. */
export function previewText({ phrase, text, target, you, info, lang = 'en', args = {} }) {
  if (text) return String(text);
  if (!phrase) return '';
  const a = autoArgs(youShip(you, info), args);
  a.to = target?.name || 'All stations';
  return render(phrase, a, lang);
}
/** Phrase rows for the list: [{ id, label }], context-sorted. */
export function phraseRows(ctx, lang = 'en') {
  const L = PHRASE_LABEL[lang] || PHRASE_LABEL.en;
  return phrasesFor(ctx).map((id) => ({ id, label: L[id] || id }));
}
/**
 * Context chips: "Call Rozenburgsesluis (ch 68)" for bridges / locks within 3 km, the VTS sector, and the presets.
 * → [{ key, label, ch, to?, phrase?, kind, hot }]
 */
export function chips({ near = [], sector = null, fallbackCh = null, ch = 16 } = {}) {
  const out = [];
  for (const n of near) {
    out.push({ key: `n:${n.id}`, label: `Call ${n.name} (ch ${n.ch})`, ch: n.ch, to: { id: n.id, name: n.name, kind: n.kind }, phrase: n.kind === 'lock' ? 'req_lock' : 'req_open', kind: n.kind, hot: n.ch !== ch, silent: !!n.silent });
  }
  if (sector) out.push({ key: `s:${sector.id}`, label: `VTS ${sector.name} (ch ${sector.ch})`, ch: sector.ch, to: { id: sector.id, name: sector.name, kind: 'vts' }, phrase: 'vts_report', kind: 'vts', hot: sector.ch !== ch });
  else if (fallbackCh) out.push({ key: 'f', label: `Port area: listen ch ${fallbackCh}`, ch: fallbackCh, kind: 'ship', hot: fallbackCh !== ch });
  for (const p of PRESETS) out.push({ key: `p:${p}`, label: String(p), ch: p, kind: 'preset', hot: false, preset: true, on: p === ch });
  return out;
}
/** Shift+Z: the bridge or lock ahead → { ch, to, phrase } | null. */
export function quickCall(near = []) {
  const n = near.find((x) => x.kind === 'bridge' || x.kind === 'lock');
  return n ? { ch: n.ch, to: { id: n.id, name: n.name, kind: n.kind }, phrase: n.kind === 'lock' ? 'req_lock' : 'req_open' } : null;
}
/** Station rows on the tuned channel → [{ id, name, kind, bars, q, silent, why, sel }]. */
export function stationRows(stations = [], selId = null) {
  return stations.map((s) => ({ ...s, sel: s.id === selId, label: s.silent ? `${s.name} — silent: ${s.why || 'out of hours'}` : s.name }));
}
/** Tab cycling: the next callable station after the selected one (silent ones are skipped). */
export function nextTarget(stations = [], selId = null, dir = 1) {
  const L = stations.filter((s) => !s.silent);
  if (!L.length) return null;
  const i = L.findIndex((s) => s.id === selId);
  if (i < 0) return dir > 0 ? L[0] : L[L.length - 1];
  return L[(i + (dir > 0 ? 1 : -1) + L.length) % L.length];
}
/** Typed digits with the set open → a voice channel, or null. */
export function parseDigits(buf) {
  const n = Number(String(buf || '').replace(/\D/g, '').slice(-2));
  return isVoice(n) ? n : null;
}
/** Knob angle (deg) for a channel: the knob turns through 300° across the voice channels. */
export function knobAngle(ch) {
  const L = Object.keys(CHANNELS).map(Number).filter((c) => CHANNELS[c].voice).sort((a, b) => a - b);
  const i = Math.max(0, L.indexOf(ch));
  return -150 + (300 * i) / Math.max(1, L.length - 1);
}
export { stepChannel };
/** Seconds a transmission "plays" (noise bed, BUSY lamp): ~65 ms per character, 1.2–9 s. */
export const playSeconds = (text) => Math.max(1.2, Math.min(9, String(text || '').length * 0.065));
/** Signal bars as text (for aria and the phone chips). */
export const barsText = (n) => '▮'.repeat(n) + '▯'.repeat(4 - n);
