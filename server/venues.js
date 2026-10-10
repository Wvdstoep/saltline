// The venues of a cruise ship the captain can use when walking through her (docs/CRUISE-CONTRACT.md §7): a drink, a meal, a show, a
// treatment, a souvenir, a lot at the art auction, a ride. Each costs what the menu (shared/ships/cruisesat.js) says, is paid from
// the purse (the money is spent aboard: it is not a ledger cost of the company), and counts as the captain being seen about the ship:
// `p.guest.visits[kind] = ship time` feeds the guest rating (guestScore: attention), which scales the pay of cruise jobs. The
// client never decides a price, a result or a rating: it sends { action: 'venue', kind, option } and shows the answer.
//   C→S { action: 'venue', kind, option, score? }      S→C { t: 'venue', ok, kind, option, text, cost, money, guest }
import crypto from 'node:crypto';
import { menuFor, guestScore, MENUS, CASINO_KINDS } from '../shared/ships/cruisesat.js';
import { cruiseProfile } from '../shared/ships/cruiseprofile.js';

const GAP_S = 3;   // seconds between two uses of the same venue
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
export const secureRnd = () => crypto.randomInt(0, 2 ** 31) / 2 ** 31;

/** The guest rating of the ship p sails now (null for ships that are not cruise ships). */
export function guestFor(game, a) {
  const cls = a?.ship?.cls; if (!cls || !cruiseProfile(cls)) return null;
  const now = game.simTime || 0;
  return guestScore({ cls, cond: Number.isFinite(a.cond) ? a.cond : 100, serviceOk: !(a.serviceDue > 0) || a.serviceDue > now, visits: a.guest?.visits || null, now });
}
/** The captain was seen at `kind` (a casino table, a bar …). */
export function visit(game, p, kind) { const g = (p.guest ||= { visits: {} }); (g.visits ||= {})[kind] = game.simTime || 0; }

/** Lot at the art auction: the painting is worth 0.4 × the bid (55 %), 1 × (35 %) or 3 × (10 %): expected return 87 %. */
export function auctionValue(bid, rnd) { const r = rnd(); return Math.round(bid * (r < 0.55 ? 0.4 : r < 0.9 ? 1 : 3)); }

export class Venues {
  constructor(game, opts = {}) { this.game = game; this.rnd = opts.rnd || secureRnd; this.last = new Map(); this.now = opts.now || (() => Date.now() / 1000); }
  reply(p, msg) { this.game.send(p, { t: 'venue', money: p.money, guest: guestFor(this.game, p), ...msg }); this.game.sendYou?.(p); }
  refuse(p, kind, option, text) { this.reply(p, { ok: false, kind, option, text }); return false; }
  onAction(p, m) {
    const kind = String(m.kind || ''), optId = String(m.option || '');
    if (CASINO_KINDS.includes(kind)) return this.refuse(p, kind, optId, 'Use the table.');
    const cls = p.ship?.cls, menu = menuFor(cls, kind);
    if (!MENUS[kind] || !menu) return this.refuse(p, kind, optId, 'This ship has no such place.');
    if (kind === 'guest') return this.reply(p, { ok: true, kind, option: 'rating', text: '' });
    const opt = menu.options.find((q) => q.id === optId);
    if (!opt) return this.refuse(p, kind, optId, 'That is not on the menu.');
    const key = `${p.id}|${kind}`, t = this.now();
    if (t - (this.last.get(key) || -1e9) < GAP_S) return this.refuse(p, kind, optId, 'One moment, please.');
    if (opt.cost > 0 && !(p.money >= opt.cost)) return this.refuse(p, kind, optId, `That costs ${opt.cost} cr; you have ${Math.floor(p.money)}.`);
    this.last.set(key, t);
    if (opt.cost > 0) { p.money -= opt.cost; (p.stats.onboard ||= { spent: 0 }); p.stats.onboard.spent += opt.cost; }
    visit(this.game, p, kind);
    let text = opt.text, extra = {};
    if (opt.auction) { const v = auctionValue(opt.cost, this.rnd); if (v > 0) p.money += v; extra.auction = v; text = v >= opt.cost * 2 ? `You win the lot, and the appraiser gasps: worth ${v} cr!` : v >= opt.cost ? `You win the lot; it is worth about ${v} cr.` : `You win the lot... and the appraiser says it is worth ${v} cr. Art is a feeling.`; }
    else if (kind === 'show') { const stars = 3 + Math.floor(this.rnd() * 3); extra.audience = stars; text = `${opt.text} The audience gives it ${stars} stars.`; }
    else if (MENUS[kind].lines?.length) text = `${pick(this.rnd, MENUS[kind].lines)} ${opt.text}`;
    if (opt.game && Number.isFinite(Number(m.score))) extra.score = Math.max(0, Math.min(100, Math.round(Number(m.score))));
    this.reply(p, { ok: true, kind, option: optId, cost: opt.cost, text, ...extra });
    return true;
  }
}
