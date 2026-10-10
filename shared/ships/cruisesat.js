// Cruise ships — what the captain can do aboard and what the guests think of the ship (docs/CRUISE-CONTRACT.md §7). Pure,
// browser-safe, deterministic. Three things:
//   MENUS / menuFor(cls, kind)       the activities of each venue kind (a drink at the bar, a massage at the spa, a show to watch …)
//                                    with their price in credits; only what the ship really has is offered
//   venueKindOf(item)                which venue kind a furniture item opens (iv2items hot kinds are 'v:<kind>')
//   guestScore(...)                  the guest rating 1-5 stars from the venues the ship has (and their number against its guests),
//                                    its crew service, its hull and the captain's attention; payMul / spendMul feed the cruise pay
import { cruiseProfile, cruiseClassOf } from './cruiseprofile.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r2 = (v) => Math.round(v * 100) / 100;

/** Furniture item → venue kind (the hotspot kind is `v:<kind>`). */
export const ITEM_KIND = Object.freeze({
  roulette: 'roulette', blackjack: 'blackjack', poker_table: 'poker', slot_island: 'slots', baccarat_table: 'baccarat',
  bar_island: 'bar', piano_bar: 'bar', pool_bar: 'bar', host_stand: 'dine', buffet_line: 'buffet', band_stage: 'show', cinema_screen: 'cinema',
  lounger_pair: 'lounger', relax_lounger: 'spa', sauna: 'spa', yoga_mat: 'gym', rack_dumbbell: 'gym', slide_tower: 'slide', hot_tub: 'hottub', pool_water: 'swim',
  mini_golf: 'golf', climb_wall: 'climb', rope_course: 'rope', rink_ice: 'rink', arcade_row: 'arcade', air_hockey: 'arcade', billiard: 'arcade', reading_table: 'library',
  art_plinth: 'art', display_case: 'shop', kiosk: 'shop', reception_long: 'guest', kids_table: 'kids', ball_pit: 'kids', surf_pool: 'surf', zip_cable: 'zip', sports_court: 'court', cashier_cage: 'cage',
});
export const kindOfItem = (item) => ITEM_KIND[item] || null;
export const CASINO_KINDS = Object.freeze(['roulette', 'blackjack', 'poker', 'slots', 'baccarat']);

const o = (id, label, cost, mood, text, extra = {}) => Object.freeze({ id, label, cost, mood, text, ...extra });
/** The activities of each venue kind. mood = how much the guests like the captain being seen there (0..1 of one visit's attention). */
export const MENUS = Object.freeze({
  bar: { title: 'Bar', needs: (p) => p.venues.bar + p.venues.lounge > 0 || p.extras.includes('panorama_lounge'),
    lines: ['“What can I get you, Captain?”', '“The usual? The guests have been asking when you will do your rounds.”', '“Quiet night — they are all at the show.”'],
    options: [o('coffee', 'Coffee', 3, 0.3, 'A proper espresso.'), o('beer', 'Draught beer', 5, 0.5, 'Cold and foamy.'), o('cocktail', 'House cocktail', 11, 0.7, 'A paper umbrella and everything.'), o('champagne', 'Champagne', 34, 1, 'The barman raises an eyebrow, then a glass.')] },
  dine: { title: 'Restaurant', needs: (p) => p.venues.main + p.venues.spec > 0,
    lines: ['“A table for the captain, of course.”', '“The sea bass is excellent tonight.”'],
    options: [o('main', 'Main dining room (set menu)', 0, 0.4, 'Three courses, linen and a view of the wake.'), o('spec', 'Specialty restaurant', 48, 1, 'Seven courses; the sommelier insists on the pairing.', { needs: (p) => p.venues.spec > 0 })] },
  buffet: { title: 'Buffet', needs: (p) => p.venues.buffet > 0, lines: ['“Plates are on the left.”'], options: [o('plate', 'Help yourself', 0, 0.2, 'You manage not to take the third dessert.'), o('breakfast', 'Late breakfast', 0, 0.2, 'Eggs, fruit and the good coffee.')] },
  show: { title: 'Theatre', needs: (p) => p.venues.theatre > 0, lines: ['“Curtain up in five minutes.”'],
    options: [o('revue', 'Broadway revue', 15, 0.8, 'A full house on its feet.'), o('magic', 'The Illusionist', 15, 0.7, 'The coin was behind your ear all along.'), o('pops', 'Symphony pops', 12, 0.6, 'Brass, strings and a lot of film music.'), o('comedy', 'Comedy night', 10, 0.6, 'Three jokes about the captain. You laugh at all of them.'),
      o('ice', 'Ice spectacular', 18, 0.9, 'Skaters and a very brave tiger costume.', { needs: (p) => p.extras.includes('ice_rink') })] },
  cinema: { title: 'Cinema', needs: (p) => p.extras.includes('cinema'), lines: [], options: [o('movie', 'Watch a film', 8, 0.4, 'The popcorn is free, the seat is not.')] },
  lounger: { title: 'Sun lounger', needs: () => true, lines: [], options: [o('relax', 'Lie back and relax', 0, 0.3, 'Sun, a light breeze and the sound of the ship. Your shoulders drop.')] },
  hottub: { title: 'Hot tub', needs: (p) => p.venues.pool > 0, lines: [], options: [o('soak', 'Soak', 0, 0.3, 'Hot water, cool air, the horizon.')] },
  swim: { title: 'Pool', needs: (p) => p.venues.pool > 0, lines: [], options: [o('swim', 'Take a swim', 0, 0.3, 'A few lengths. The guests wave.')] },
  slide: { title: 'Water slide', needs: (p) => p.venues.slide > 0 || p.extras.includes('water_park'), lines: [], options: [o('ride', 'Ride the slide', 0, 0.6, 'Down you go!', { ride: true })] },
  spa: { title: 'Spa', needs: (p) => p.venues.spa > 0, lines: ['“Welcome to the spa. Leave your cares at the door.”'],
    options: [o('sauna', 'Sauna', 12, 0.4, 'Eighty degrees of silence.'), o('massage', 'Massage (50 min)', 95, 0.9, 'Your back files a formal thank-you.'), o('facial', 'Facial', 70, 0.7, 'You smell faintly of cucumber.')] },
  gym: { title: 'Gym', needs: (p) => p.venues.gym > 0, lines: [], options: [o('workout', 'Work out', 0, 0.3, 'Forty minutes on a treadmill facing the sea.'), o('yoga', 'Yoga class', 6, 0.4, 'Downward-facing captain.')] },
  shop: { title: 'Shop', needs: (p) => p.venues.shop > 0, lines: ['“Souvenirs for the family?”'],
    options: [o('postcard', 'Postcards', 4, 0.1, 'Ten postcards of your own ship.'), o('mug', 'Ship mug', 12, 0.2, 'Dishwasher safe.'), o('tshirt', 'T-shirt', 35, 0.3, 'It says “I survived the buffet”.'), o('watch', 'Brand-name watch', 420, 0.5, 'Duty free, naturally.'), o('model', 'Model of this ship', 160, 0.4, 'One in two hundred.')] },
  art: { title: 'Art gallery', needs: (p) => p.extras.includes('art_gallery') || p.extras.includes('photo_gallery'), lines: ['“The auction starts at nine.”'],
    options: [o('look', 'Look around', 0, 0.2, 'Three paintings of lighthouses and one of a very large cat.'), o('auction', 'Bid at the auction', 300, 0.4, 'Lot 17, “Calm sea”. Do you bid?', { auction: true })] },
  library: { title: 'Library', needs: (p) => p.extras.includes('library'), lines: [], options: [o('read', 'Read for an hour', 0, 0.3, 'A chapter turns into three.')] },
  arcade: { title: 'Arcade', needs: (p) => p.extras.includes('arcade') || p.venues.kids > 0, lines: [], options: [o('play', 'Play (reaction game)', 2, 0.3, 'Hit the targets as they light up.', { game: 'reaction' })] },
  kids: { title: "Kids' club", needs: (p) => p.venues.kids > 0, lines: ['“The captain! Children, what do we say?”'], options: [o('visit', 'Visit the kids', 0, 0.8, 'You hand out paper captain’s hats. You are a hero.')] },
  golf: { title: 'Mini-golf', needs: (p) => p.extras.includes('mini_golf'), lines: [], options: [o('putt', 'Play a round (timing game)', 3, 0.4, 'Hit the ball when the bar is in the green.', { game: 'timing' })] },
  climb: { title: 'Climbing wall', needs: (p) => p.extras.includes('climbing_wall'), lines: [], options: [o('climb', 'Climb (timing game)', 3, 0.4, 'Press at the right moment for every hold.', { game: 'timing' })] },
  rope: { title: 'Rope course', needs: (p) => p.extras.includes('rope_course'), lines: [], options: [o('rope', 'Rope course (timing game)', 4, 0.5, 'Balance along the beams.', { game: 'timing' })] },
  rink: { title: 'Ice rink', needs: (p) => p.extras.includes('ice_rink'), lines: [], options: [o('skate', 'Skate (timing game)', 4, 0.5, 'Keep the rhythm round the rink.', { game: 'timing' })] },
  court: { title: 'Sports court', needs: (p) => p.extras.includes('sports_court'), lines: [], options: [o('hoops', 'Shoot hoops (timing game)', 0, 0.3, 'Release at the top of the arc.', { game: 'timing' })] },
  surf: { title: 'Surf simulator', needs: (p) => p.extras.includes('surf_simulator'), lines: [], options: [o('surf', 'Surf (timing game)', 8, 0.6, 'Stay on the wave.', { game: 'timing' })] },
  zip: { title: 'Zip line', needs: (p) => p.extras.includes('zip_line'), lines: [], options: [o('zip', 'Ride the zip line', 6, 0.6, 'Whoooosh.', { ride: true })] },
  cage: { title: 'Cashier', needs: (p) => p.venues.casino > 0, lines: ['“Table limits are posted on every table.”'], options: [o('info', 'Ask about the limits', 0, 0, 'Posted on every table; the house keeps its edge.')] },
  guest: { title: 'Guest services', needs: () => true, lines: [], options: [] },
});
/** The menu of venue `kind` on ship `cls` (null when the ship has no such venue). */
export function menuFor(cls, kind) {
  const p = cruiseProfile(cls), m = MENUS[kind]; if (!p || !m || !m.needs(p)) return null;
  return { kind, title: m.title, lines: m.lines, options: m.options.filter((q) => !q.needs || q.needs(p)) };
}

// ------------------------------------------------------------------------------------------------ guest rating
/** Attractions the guests judge, by group: [group, count of the ship's venues, venues wanted for its guests]. */
export function attractionGroups(cls) {
  const p = cruiseProfile(cls); if (!p) return [];
  const v = p.venues, ex = new Set(p.extras), g = p.guests, per = (n) => Math.max(1, Math.round(g / n));
  const has = (...k) => k.filter((x) => ex.has(x)).length;
  const rows = [
    ['dining', v.main + v.spec + v.buffet + v.court, Math.max(1, Math.round(g / 900)) + (g > 400 ? 1 : 0)],
    ['bars', v.bar + v.lounge, Math.max(1, Math.round(g / 500))],
    ['shows', v.theatre + v.club + v.casino + has('cinema', 'aqua_theatre'), g > 700 ? 3 : g > 250 ? 2 : 1],
    ['pool & sun', v.pool + v.slide + has('water_park', 'surf_simulator'), g > 1000 ? 3 : 1],
    ['wellness', v.spa + v.gym, g > 250 ? 2 : 1],
    ['family', v.kids + v.teens + has('arcade'), g > 1500 ? 3 : g > 700 ? 2 : 0],
    ['shopping', v.shop, Math.max(1, Math.round(g / 900))],
    ['sports', has('ice_rink', 'climbing_wall', 'mini_golf', 'sports_court', 'rope_course', 'zip_line', 'surf_simulator'), g > 2500 ? 5 : g > 1200 ? 3 : 0],
    ['culture', has('library', 'art_gallery', 'photo_gallery', 'card_room', 'lecture_hall', 'observation'), g > 300 ? 2 : 1],
  ];
  void per;
  return rows.filter((r) => r[2] > 0).map(([n, c, w]) => ({ group: n, have: c, want: w, cover: r2(clamp(c / w, 0, 1)) }));
}
/** The most the captain's attention can lift the rating: distinct venue kinds visited within a ship-day. */
export const ATTENTION = Object.freeze({ WINDOW_S: 86400, KINDS: 6 });
export function attentionOf(visits, now) {
  if (!visits) return 0;
  let n = 0; for (const [k, t] of Object.entries(visits)) if (k !== 'guest' && Number.isFinite(t) && now - t < ATTENTION.WINDOW_S && now - t >= -60) n++;
  return clamp(n / ATTENTION.KINDS, 0, 1);
}
/**
 * The guest rating of ship `cls`. in: { cond (hull %), serviceOk (bool: the ship is serviced and her crew rested), visits ({ kind: shipTime }), now }.
 * → { score (0..1), stars (1..5 in 0.1), parts: { variety, staff, hull, attention }, payMul, spendMul, groups, tips }.
 * Weights 45 % attractions, 20 % crew service, 15 % hull, 20 % the captain being seen about the ship. payMul (0.8..1.1) and spendMul
 * (0.75..1.12) multiply the ticket / onboard spending of a cruise (server/jobsx.js); a ship in good order whose captain is never seen scores
 * about 0.80 (×1.00); a captain who walks the ship earns up to +10 %, a neglected ship loses up to 20 %.
 */
export function guestScore({ cls, cond = 100, serviceOk = true, visits = null, now = 0 } = {}) {
  const groups = attractionGroups(cls); if (!groups.length) return null;
  const variety = groups.reduce((s, g) => s + g.cover, 0) / groups.length, staff = serviceOk ? 1 : 0.55, hull = clamp(cond / 100, 0, 1), attention = attentionOf(visits, now);
  const score = clamp(0.45 * variety + 0.2 * staff + 0.15 * hull + 0.2 * attention, 0, 1);
  const tips = [];
  for (const g of groups) if (g.cover < 0.8) tips.push(`Guests would like more ${g.group} (${g.have} of ${g.want}).`);
  if (!serviceOk) tips.push('The crew is overworked: service the ship.');
  if (hull < 0.9) tips.push('Hull damage is spoiling the voyage.');
  if (attention < 0.5) tips.push('Guests like to see the captain about the ship: visit the bars, restaurants, the theatre, the pool.');
  return { score: r2(score), stars: Math.round((1 + 4 * score) * 10) / 10, parts: { variety: r2(variety), staff, hull: r2(hull), attention: r2(attention) }, payMul: r2(clamp(1 + 0.5 * (score - 0.8), 0.8, 1.1)), spendMul: r2(clamp(1 + 0.6 * (score - 0.8), 0.75, 1.12)), groups, tips };
}
export { cruiseClassOf };
