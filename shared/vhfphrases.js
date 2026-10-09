// VHF phrases and dialogue templates, English (SMCP style) and Dutch (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6.4, lane B).
// The same phrase id + args go over the wire; each receiver renders its own language. Pure, import-only from shared/vhf.js.
import { dirWordOf } from './vhf.js';

export const LANGS = Object.freeze(['en', 'nl']);

// Word tables for args that are keys rather than names (a raw value that is not a key is shown as is).
const WORDS = {
  en: {
    dir: { north: 'northbound', south: 'southbound', east: 'eastbound', west: 'westbound', up: 'upbound', down: 'downbound', in: 'inbound', out: 'outbound' },
    side: { port: 'port', stbd: 'starboard', north: 'north', south: 'south', east: 'east', west: 'west' },
    where: { waiting: 'at the waiting berth', approach: 'on the approach', south: 'south side', north: 'north side', east: 'east side', west: 'west side', here: 'where you are', lockN: 'at the north waiting berth', lockS: 'at the south waiting berth' },
    head: { upper: 'upper', lower: 'lower', north: 'north', south: 'south', east: 'east', west: 'west' },
    type: { sail_yacht: 'sailing yacht', motor_yacht: 'motor yacht', general: 'general cargo ship', container: 'container ship', tanker: 'tanker', bulk: 'bulk carrier', tug: 'tug', barge: 'motor barge', ferry: 'ferry', fishing: 'fishing vessel', pilot: 'pilot boat', workboat: 'workboat', ship: 'vessel' },
    why: { rush: 'rush hour', train: 'train traffic', works: 'maintenance', wind: 'too much wind' },
    nature: { fire: 'fire on board', flooding: 'flooding', sinking: 'sinking', collision: 'collision', grounding: 'aground', mob: 'man overboard', medical: 'medical emergency', disabled: 'disabled and adrift', undesignated: 'undesignated distress', danger: 'danger to navigation', weather: 'severe weather' },
    kind: { distress: 'DISTRESS', urgency: 'URGENCY', safety: 'SAFETY' },
    and: 'and', none: 'no reported traffic', m: 'metres',
  },
  nl: {
    dir: { north: 'noordgaand', south: 'zuidgaand', east: 'oostgaand', west: 'westgaand', up: 'opvarend', down: 'afvarend', in: 'invarend', out: 'uitvarend' },
    side: { port: 'bakboord', stbd: 'stuurboord', north: 'noordzijde', south: 'zuidzijde', east: 'oostzijde', west: 'westzijde' },
    where: { waiting: 'bij de wachtplaats', approach: 'in de aanloop', south: 'aan de zuidzijde', north: 'aan de noordzijde', east: 'aan de oostzijde', west: 'aan de westzijde', here: 'waar u bent', lockN: 'bij de noordelijke wachtplaats', lockS: 'bij de zuidelijke wachtplaats' },
    head: { upper: 'boven', lower: 'beneden', north: 'noord', south: 'zuid', east: 'oost', west: 'west' },
    type: { sail_yacht: 'zeiljacht', motor_yacht: 'motorjacht', general: 'vrachtschip', container: 'containerschip', tanker: 'tanker', bulk: 'bulkcarrier', tug: 'sleepboot', barge: 'motorvrachtschip', ferry: 'veerboot', fishing: 'vissersschip', pilot: 'loodsboot', workboat: 'werkboot', ship: 'schip' },
    why: { rush: 'spits', train: 'treinverkeer', works: 'onderhoud', wind: 'te veel wind' },
    nature: { fire: 'brand aan boord', flooding: 'waterlek', sinking: 'zinkend', collision: 'aanvaring', grounding: 'aan de grond', mob: 'man overboord', medical: 'medisch noodgeval', disabled: 'stuurloos en drijvend', undesignated: 'noodsituatie', danger: 'gevaar voor de scheepvaart', weather: 'zwaar weer' },
    kind: { distress: 'nood', urgency: 'spoed', safety: 'veiligheids' },
    and: 'en', none: 'geen verkeer gemeld', m: 'meter',
  },
};

// {slot} templates. `P:` prefix = the station call ("{to}, this is {me}, …") is added in front.
const T = {
  en: {
    // player phrases
    call: '{to}, {to}, this is {me}, {me}, over.',
    req_open: 'P:{dir} {where}, air draught {ad} metres, request bridge opening, over.',
    req_lock: 'P:{dir}, {type} {L} by {B} metres, draught {T}, request lock passage, over.',
    vts_report: 'P:{where}, {dir} to {dest}, draught {T}, over.',
    pass_port: 'P:I will pass you port to port, over.',
    pass_stbd: 'P:I will pass you starboard to starboard, over.',
    overtake: 'P:request to overtake you on your {side} side, over.',
    ack: 'Received, {to}, out.',
    say_again: 'Say again, over.',
    radio_check: 'P:radio check, how do you read me, over.',
    mayday: 'MAYDAY, MAYDAY, MAYDAY, this is {me}, {me}, {me}. MAYDAY {me}, position {pos}, {nature}, {pob} persons on board, require immediate assistance, over.',
    panpan: 'PAN-PAN, PAN-PAN, PAN-PAN, all stations, this is {me}. Position {pos}, {nature}, {pob} persons on board, over.',
    securite: 'SÉCURITÉ, SÉCURITÉ, SÉCURITÉ, all stations, this is {me}. {dir} at {pos}, {nature}, out.',
    // bridges
    op_br_wait: '{ship}, {st}. Next opening in {in} minutes at {hhmm}, you are number {n}. Wait {where}, over.',
    op_br_under: '{ship}, {st}. Clearance is {clr} metres now, you can pass under. {st} out.',
    op_br_under_nc: '{ship}, {st}. You fit under the closed bridge, you can pass under. {st} out.',
    op_br_opening: '{ship}, {st}, bridge is opening, proceed on green.',
    op_br_open: '{ship}, {st}, bridge is open, proceed on green, over.',
    op_br_closed: '{st}, bridge closing. {st} out.',
    op_br_block: '{ship}, {st}. No openings until {hhmm} ({why}). Wait {where}, over.',
    op_br_night: '{ship}, {st}. Opening at {hhmm}, with one hour notice.',
    op_br_never: '{ship}, {st}. Open clearance is {clrO} metres, you will not pass. Advise route via {alt}.',
    op_br_out: '{ship}, {st}. The bridge is out of service until {hhmm}, over.',
    op_br_far: '{ship}, {st}. Call again when you are within 3 kilometres, over.',
    op_br_missed: '{ship}, {st}. You missed the opening, next opening, over.',
    op_unable: '{ship}, {st}. Unable, over.',
    // locks
    op_lk_queue: '{ship}, {st}. You are number {n} for chamber {chamber}, next {dir} cycle in {in} minutes. Make fast {side} side {where}, over.',
    op_lk_nofit: '{ship}, {st}. You do not fit the chamber, {why}, over.',
    op_lk_enter: '{ship}, enter on green, make fast {side} side, {slot} metres from the {head} gate.',
    op_lk_closing: '{st}, gates closing.',
    op_lk_level: '{st}, levelling, {dh} metres, about {min} minutes.',
    op_lk_leave: '{st}, gates opening, leave on green, have a good trip.',
    op_lk_fee: '{ship}, lock fee {fee} credits.',
    op_lk_lost: '{ship}, {st}. You lost your turn, call again for the next cycle, over.',
    // VTS
    op_vts_ack: '{ship}, {st}. Roger, {dir} to {dest}. Traffic: {traffic}. {st} out.',
    op_vts_redirect: '{ship}, {st}. You are in sector {x}, call on channel {y}.',
    op_vts_goahead: '{ship}, {st}, go ahead, over.',
    // coast guard
    op_cg_switch: '{ship}, {st}, switch to channel {y}, over.',
    op_cg_goahead: '{ship}, {st}, go ahead, over.',
    op_cg_mayday: 'MAYDAY {ship}, this is {st}, received MAYDAY. Rescue units alerted, stay on channel 16, over.',
    op_cg_ack: '{ship}, this is {st}, received, we are monitoring, stay on channel 16, over.',
    op_cg_check: '{ship}, {st}, reading you {q} of five, over.',
    // harbours
    op_hm_goahead: '{ship}, {st}, go ahead, over.',
    // AI ships
    ai_goahead: '{ship}, this is {st}, go ahead, over.',
    ai_switch: '{ship}, {st}, switch to channel {y}, over.',
    ai_pass_port: '{ship}, {st}. Port to port, agreed. {st} out.',
    ai_pass_stbd: '{ship}, {st}. Starboard to starboard, agreed. {st} out.',
    ai_overtake: '{ship}, {st}. You may overtake on my {side} side, I keep my course and speed. {st} out.',
    ai_check: '{ship}, {st}, reading you {q} of five, over.',
    // DSC (shown on the set's display, not spoken)
    dsc_alert: 'DSC {kind} alert from {me}, position {pos}, {nature}.',
  },
  nl: {
    call: '{to}, {to}, hier is de {me}, {me}, over.',
    req_open: 'P:{dir} {where}, hoogte {ad} meter, graag een brugopening, over.',
    req_lock: 'P:{dir}, {type} {L} bij {B} meter, diepgang {T}, verzoek om te schutten, over.',
    vts_report: 'P:{where}, {dir} naar {dest}, diepgang {T}, over.',
    pass_port: 'P:ik passeer u bakboord op bakboord, over.',
    pass_stbd: 'P:ik passeer u stuurboord op stuurboord, over.',
    overtake: 'P:verzoek u op te lopen aan uw {side}zijde, over.',
    ack: 'Begrepen, {to}, sluiten.',
    say_again: 'Herhaal, over.',
    radio_check: 'P:proefoproep, hoe ontvangt u mij, over.',
    mayday: 'MAYDAY, MAYDAY, MAYDAY, hier is de {me}, {me}, {me}. MAYDAY {me}, positie {pos}, {nature}, {pob} personen aan boord, verzoek onmiddellijke assistentie, over.',
    panpan: 'PAN-PAN, PAN-PAN, PAN-PAN, aan alle stations, hier is de {me}. Positie {pos}, {nature}, {pob} personen aan boord, over.',
    securite: 'SÉCURITÉ, SÉCURITÉ, SÉCURITÉ, aan alle stations, hier is de {me}. {dir} bij {pos}, {nature}, sluiten.',
    op_br_wait: '{ship}, {st}. Volgende opening over {in} minuten om {hhmm}, u bent nummer {n}. Wacht {where}, over.',
    op_br_under: '{ship}, {st}. De doorvaarthoogte is nu {clr} meter, u kunt eronderdoor. {st} sluiten.',
    op_br_under_nc: '{ship}, {st}. U past onder de gesloten brug, u kunt eronderdoor. {st} sluiten.',
    op_br_opening: '{ship}, {st}, de brug gaat open, doorvaren op groen.',
    op_br_open: '{ship}, {st}, de brug is open, doorvaren op groen, over.',
    op_br_closed: '{st}, de brug gaat dicht. {st} sluiten.',
    op_br_block: '{ship}, {st}. Geen bediening tot {hhmm} ({why}). Wacht {where}, over.',
    op_br_night: '{ship}, {st}. Opening om {hhmm}, met een uur vooraanmelding.',
    op_br_never: '{ship}, {st}. De hoogte open is {clrO} meter, u kunt niet passeren. Advies: route via {alt}.',
    op_br_out: '{ship}, {st}. De brug is buiten dienst tot {hhmm}, over.',
    op_br_far: '{ship}, {st}. Roep opnieuw op binnen 3 kilometer, over.',
    op_br_missed: '{ship}, {st}. U hebt de opening gemist, volgende opening, over.',
    op_unable: '{ship}, {st}. Niet mogelijk, over.',
    op_lk_queue: '{ship}, {st}. U bent nummer {n} voor kolk {chamber}, volgende {dir} schutting over {in} minuten. Afmeren {side} {where}, over.',
    op_lk_nofit: '{ship}, {st}. U past niet in de kolk, {why}, over.',
    op_lk_enter: '{ship}, invaren op groen, afmeren {side}, {slot} meter van de {head}deur.',
    op_lk_closing: '{st}, de deuren gaan dicht.',
    op_lk_level: '{st}, nivelleren, {dh} meter, ongeveer {min} minuten.',
    op_lk_leave: '{st}, de deuren gaan open, uitvaren op groen, goede reis.',
    op_lk_fee: '{ship}, sluisgeld {fee} credits.',
    op_lk_lost: '{ship}, {st}. U bent uw beurt kwijt, roep opnieuw op voor de volgende schutting, over.',
    op_vts_ack: '{ship}, {st}. Begrepen, {dir} naar {dest}. Verkeer: {traffic}. {st} sluiten.',
    op_vts_redirect: '{ship}, {st}. U bent in sector {x}, roep op kanaal {y}.',
    op_vts_goahead: '{ship}, {st}, zegt u het maar, over.',
    op_cg_switch: '{ship}, {st}, ga naar kanaal {y}, over.',
    op_cg_goahead: '{ship}, {st}, zegt u het maar, over.',
    op_cg_mayday: 'MAYDAY {ship}, hier is {st}, MAYDAY ontvangen. Reddingseenheden gealarmeerd, blijf op kanaal 16, over.',
    op_cg_ack: '{ship}, hier is {st}, ontvangen, wij luisteren uit, blijf op kanaal 16, over.',
    op_cg_check: '{ship}, {st}, ontvang u {q} van vijf, over.',
    op_hm_goahead: '{ship}, {st}, zegt u het maar, over.',
    ai_goahead: '{ship}, hier is de {st}, zegt u het maar, over.',
    ai_switch: '{ship}, {st}, ga naar kanaal {y}, over.',
    ai_pass_port: '{ship}, {st}. Bakboord op bakboord, akkoord. {st} sluiten.',
    ai_pass_stbd: '{ship}, {st}. Stuurboord op stuurboord, akkoord. {st} sluiten.',
    ai_overtake: '{ship}, {st}. U kunt oplopen aan mijn {side}zijde, ik houd koers en vaart. {st} sluiten.',
    ai_check: '{ship}, {st}, ontvang u {q} van vijf, over.',
    dsc_alert: 'DSC-{kind}melding van de {me}, positie {pos}, {nature}.',
  },
};
const PREFIX = { en: '{to}, this is {me}, ', nl: '{to}, hier is de {me}, ' };

export const PHRASE_IDS = Object.freeze(Object.keys(T.en));
/** Phrases a player may send (the server refuses the operator ids from a player). */
export const PLAYER_PHRASES = Object.freeze(['call', 'req_open', 'req_lock', 'vts_report', 'pass_port', 'pass_stbd', 'overtake', 'ack', 'say_again', 'radio_check', 'mayday', 'panpan', 'securite']);
export const isPlayerPhrase = (id) => PLAYER_PHRASES.includes(id);
/** Short labels for the phrase list / chips. */
export const PHRASE_LABEL = Object.freeze({
  en: { call: 'Call', req_open: 'Request opening', req_lock: 'Request lock passage', vts_report: 'Report to VTS', pass_port: 'Pass port to port', pass_stbd: 'Pass starboard to starboard', overtake: 'Request to overtake', ack: 'Received, out', say_again: 'Say again', radio_check: 'Radio check', mayday: 'MAYDAY', panpan: 'PAN-PAN', securite: 'SÉCURITÉ' },
  nl: { call: 'Oproep', req_open: 'Brugopening vragen', req_lock: 'Schutten aanvragen', vts_report: 'Melden bij verkeerspost', pass_port: 'Bakboord op bakboord', pass_stbd: 'Stuurboord op stuurboord', overtake: 'Verzoek oplopen', ack: 'Begrepen, sluiten', say_again: 'Herhaal', radio_check: 'Proefoproep', mayday: 'MAYDAY', panpan: 'PAN-PAN', securite: 'SÉCURITÉ' },
});

/** Number in the language's style: 17.0 / 17,0. */
export function fmtNum(v, lang = 'en', dp = 1) {
  if (!Number.isFinite(+v)) return String(v ?? '?');
  const s = (+v).toFixed(dp);
  return lang === 'nl' ? s.replace('.', ',') : s;
}
const NUM_DP = { ad: 1, T: 1, L: 0, B: 1, clr: 1, clrO: 1, dh: 2, in: 0, min: 0, slot: 0, n: 0, fee: 0, q: 0, pob: 0 };
function word(lang, table, v) { const t = WORDS[lang][table]; return t && v != null && t[v] != null ? t[v] : v; }
function list(lang, names) {
  if (!Array.isArray(names)) return names;
  if (!names.length) return WORDS[lang].none;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} ${WORDS[lang].and} ${names[names.length - 1]}`;
}
function fmtPos(pos) {
  if (!Array.isArray(pos)) return pos;
  const f = (v, p, n) => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return `${d}°${m.toFixed(1).padStart(4, '0')}′${v >= 0 ? p : n}`; };
  return `${f(pos[0], 'N', 'S')} ${f(pos[1], 'E', 'W')}`;
}
/** Render one arg for a slot. */
function argText(lang, k, v) {
  if (v == null || v === '') return '?';
  switch (k) {
    case 'dir': return word(lang, 'dir', v);
    case 'side': return word(lang, 'side', v);
    case 'where': return WORDS[lang].where[v] ?? (lang === 'nl' ? `bij ${v}` : `at ${v}`);   // a key, else a place name
    case 'head': return word(lang, 'head', v);
    case 'type': return word(lang, 'type', v);
    case 'why': return word(lang, 'why', v);
    case 'nature': return word(lang, 'nature', v);
    case 'kind': return word(lang, 'kind', v);
    case 'traffic': return list(lang, v);
    case 'pos': return fmtPos(v);
    default: return k in NUM_DP && Number.isFinite(+v) && typeof v !== 'string' ? fmtNum(v, lang, NUM_DP[k]) : String(v);
  }
}
/** Pick the language: 'en' | 'nl' | 'auto' (auto → inland in NL with a Dutch UI → nl, else en; Q16). */
export function langFor(setting, { inlandNL = false, uiLang = 'en' } = {}) {
  if (setting === 'en' || setting === 'nl') return setting;
  return inlandNL && String(uiLang).toLowerCase().startsWith('nl') ? 'nl' : 'en';
}
/** Render a phrase id + args in a language. Unknown id → ''. Missing args show '?'. */
export function render(id, args = {}, lang = 'en') {
  const L = T[lang] ? lang : 'en';
  let t = T[L][id];
  if (t == null) return '';
  if (t.startsWith('P:')) t = PREFIX[L] + t.slice(2);
  const out = t.replace(/\{(\w+)\}/g, (_, k) => argText(L, k, args[k]));
  return out.charAt(0).toUpperCase() + out.slice(1);
}
/** A received message → text: free text as is, else the phrase rendered in the receiver's language. */
export function textOf(msg, lang = 'en') {
  if (!msg) return '';
  if (msg.text) return msg.text;
  return render(msg.phrase, msg.args || {}, lang);
}

/**
 * Player phrases, context-sorted (§1.1 "Request opening" first near a movable bridge). ctx: { target: {kind} | null,
 * near: {kind} | null, ch }. → [id].
 */
export function phrasesFor(ctx = {}) {
  const k = ctx.target?.kind || ctx.near?.kind || null;
  const first = k === 'bridge' ? ['req_open', 'call']
    : k === 'lock' ? ['req_lock', 'req_open', 'call']
      : k === 'vts' ? ['vts_report', 'call']
        : k === 'ship' || k === 'player' ? ['pass_port', 'pass_stbd', 'overtake', 'call']
          : k === 'cg' ? ['call', 'radio_check']
            : ['call'];
  const rest = ['ack', 'say_again', 'radio_check', 'pass_port', 'pass_stbd', 'overtake', 'req_open', 'req_lock', 'vts_report', 'securite', 'panpan'];
  const out = [];
  for (const id of [...first, ...rest]) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * The auto-filled args of a player's phrase from the ship's own numbers (the server fills these authoritatively; the
 * client uses the same function for the preview). ship: { name, hdg, lat, lon, ad, T, L, B, type }.
 */
export function autoArgs(ship = {}, extra = {}) {
  const a = {
    me: ship.name || '?', dir: dirWordOf(ship.hdg), ad: round1(ship.ad), T: round1(ship.T), L: Math.round(ship.L || 0), B: round1(ship.B),
    type: ship.type || 'ship', pos: Number.isFinite(ship.lat) ? [ship.lat, ship.lon] : null, where: ship.where || 'approach',
  };
  for (const k of ['to', 'dest', 'side', 'nature', 'pob']) if (extra[k] != null) a[k] = extra[k];
  if (a.side == null) a.side = 'port';
  if (a.pob == null) a.pob = ship.pob ?? 1;
  if (a.nature == null) a.nature = 'undesignated';
  if (a.dest == null) a.dest = ship.dest || '?';
  return a;
}
/** Phrase ship-type key from a class id (+ optional sail flag): 'sail_yacht' | 'motor_yacht' | 'container' | … | 'ship'. */
export function typeKeyOf(cls, { sail = false } = {}) {
  const c = String(cls || '').toLowerCase();
  if (sail || /sloop|ketch|schooner|catamaran|yawl|sail/.test(c)) return 'sail_yacht';
  const rules = [[/yacht|cruiser|flybridge|myacht/, 'motor_yacht'], [/tug/, 'tug'], [/tank/, 'tanker'], [/bulk/, 'bulk'], [/feeder|box|container|shortsea/, 'container'],
    [/ferry|ropax|cruise/, 'ferry'], [/fish|trawl/, 'fishing'], [/pilot/, 'pilot'], [/barge|spits|kempenaar|dortmunder|rhine/, 'barge'], [/coaster|general|gc\d/, 'general'], [/work|supply|offshore/, 'workboat']];
  for (const [re, k] of rules) if (re.test(c)) return k;
  return 'ship';
}
function round1(v) { return Number.isFinite(+v) ? Math.round(+v * 10) / 10 : null; }
