// Cruise itineraries and the cruise income model (docs/CRUISE-CONTRACT.md §3). Pure data + pure functions, browser-safe.
// An itinerary is a real-style cruise: a home port, a list of calls (harbour ids of the game), whether the ship returns
// home or ends at the last port (world-cruise legs), the nights sold and the ports where the guests spend a day. The job
// generator (server/jobsgen.js B.cruise) turns one into board steps: sail to a call (dock), guests ashore (chartered
// work hours), sea days, … and back. Russian ports are not used (politics: measures against RU, and no reasonable
// player-facing cruise sells them). Every port must also pass the ship's length / draught / cruise-berth checks.
import { cruiseClassOf, onboardIndex } from '../ships/cruiseprofile.js';

export const ITINERARIES = Object.freeze([
  { id: 'med_west', name: 'Western Mediterranean', nights: 7, home: ['barcelona', 'civitavecchia', 'genoa', 'marseille', 'naples'], calls: ['marseille', 'genoa', 'civitavecchia', 'naples', 'palma', 'barcelona', 'livorno'], n: [4, 5] },
  { id: 'med_east', name: 'Eastern Mediterranean', nights: 10, home: ['piraeus', 'civitavecchia', 'naples', 'istanbul'], calls: ['naples', 'valletta', 'piraeus', 'istanbul', 'civitavecchia'], n: [4, 5] },
  { id: 'carib_east', name: 'Eastern Caribbean', nights: 7, home: ['miami', 'san_juan'], calls: ['san_juan', 'kingston', 'miami'], n: [2, 3] },
  { id: 'carib_west', name: 'Western Caribbean', nights: 7, home: ['miami', 'galveston'], calls: ['kingston', 'cartagena_co', 'panama_colon', 'miami', 'galveston'], n: [3, 3] },
  { id: 'baltic', name: 'Baltic capitals', nights: 10, home: ['kiel', 'copenhagen', 'stockholm'], calls: ['copenhagen', 'gdansk', 'stockholm', 'helsinki', 'tallinn', 'kiel'], n: [4, 5] },
  { id: 'norway', name: 'Norwegian fjords and the North Cape', nights: 10, home: ['southampton', 'bergen', 'oslo'], calls: ['bergen', 'tromso', 'oslo'], n: [2, 3] },
  { id: 'iceland', name: 'Iceland and the Atlantic', nights: 12, home: ['southampton', 'reykjavik', 'bergen'], calls: ['reykjavik', 'bergen'], n: [2, 2] },
  { id: 'atlantic_islands', name: 'Atlantic islands', nights: 10, home: ['lisbon', 'las_palmas'], calls: ['santa_cruz_tenerife', 'las_palmas', 'lisbon'], n: [2, 3] },
  { id: 'alaska', name: 'Alaska glaciers', nights: 14, home: ['seattle', 'vancouver'], calls: ['vancouver', 'anchorage', 'seattle'], n: [2, 2] },
  { id: 'south_america', name: 'South American coast', nights: 10, home: ['buenos_aires', 'santos', 'rio_de_janeiro'], calls: ['santos', 'rio_de_janeiro', 'buenos_aires'], n: [2, 3] },
  // expedition cruises: no harbour calls, landings at sites (lat/lon of the anchorage; the guests go ashore by Zodiac)
  { id: 'antarctic', name: 'Antarctic Peninsula', nights: 12, home: ['ushuaia'], polar: true, sites: [{ name: 'Deception Island', lat: -62.97, lon: -60.65 }, { name: 'Paradise Bay', lat: -64.85, lon: -62.87 }, { name: 'Neko Harbour', lat: -64.83, lon: -62.53 }] },
  { id: 'greenland', name: 'West Greenland icefjords', nights: 10, home: ['nuuk'], polar: true, sites: [{ name: 'Sisimiut', lat: 66.94, lon: -53.67 }, { name: 'Disko Bay', lat: 69.22, lon: -51.1 }] },
  { id: 'svalbard', name: 'Svalbard and the pack ice', nights: 10, home: ['tromso'], polar: true, sites: [{ name: 'Bear Island', lat: 74.4, lon: 19.0 }, { name: 'Magdalenefjorden', lat: 79.58, lon: 11.05 }, { name: 'Longyearbyen', lat: 78.22, lon: 15.63 }] },
  { id: 'subantarctic', name: 'Subantarctic islands', nights: 12, home: ['hobart'], polar: true, sites: [{ name: 'Macquarie Island', lat: -54.62, lon: 158.86 }, { name: 'Campbell Island', lat: -52.55, lon: 169.15 }] },
  // world-cruise legs: one way, several weeks, ships that sell them are the big ones
  { id: 'world_atlantic', name: 'World cruise: Southampton to Cape Town', nights: 21, oneWay: true, home: ['southampton'], calls: ['lisbon', 'las_palmas', 'cape_town'], n: [3, 3], minGuests: 800 },
  { id: 'world_asia', name: 'World cruise: Singapore to Dubai', nights: 18, oneWay: true, home: ['singapore'], calls: ['colombo', 'mumbai', 'dubai_jebel_ali'], n: [3, 3], minGuests: 800 },
  { id: 'world_pacific', name: 'World cruise: Sydney to Vancouver', nights: 21, oneWay: true, home: ['sydney'], calls: ['auckland', 'honolulu', 'vancouver'], n: [3, 3], minGuests: 800 },
]);

/** Itineraries that start from harbour id `home`. */
export function itinerariesFrom(home) { return ITINERARIES.filter((it) => it.home.includes(home)); }

/**
 * The calls of itinerary `it` for a ship that can use `portOk(id)`: the listed calls in order, a port that does not fit is
 * dropped (the cruise line re-routes), the home port is never a call; null when fewer than 2 calls remain.
 */
export function callsOf(it, home, portOk = () => true) {
  const out = [];
  for (const id of it.calls) if (id !== home && portOk(id) && !out.includes(id)) out.push(id);
  const [lo, hi] = it.n;
  if (out.length < Math.min(2, lo)) return null;
  return out.slice(0, hi);
}

// ------------------------------------------------------------------------------------------------ income
/** Net ticket fare, cr per guest-hour, by cruise class: the charter fee after provisioning, commissions and agent costs
 * (Game rule; small luxury and expedition ships sell dearer berths, the big mainstream ships a lower fare per head). */
export const CRUISE_FARE = Object.freeze({ river: 18, boutique: 40, expedition: 36, mid: 16, premium: 12, large: 10.5, mega: 9.4, giga: 9.4 });
export const CRUISE_RULES = Object.freeze({
  OCCUPANCY: [0.75, 1.0],          // share of the berths sold
  LATE_PER_CALL: 0.08, LATE_MAX: 0.48,   // each call reached after its timetable: −8 %, at most −48 %
  ROUGH_MAX: 0.2,                  // share of the sailing time in rough seas (Hs > 1.5 m) × 20 % refunds at most
  DAMAGE_PER_PCT: 0.02, DAMAGE_MAX: 0.5, DAMAGE_FREE_PCT: 1,   // hull condition lost: −2 % pay per point over 1
  OVERRUN: 0.25,                   // the whole cruise ran past its allowed hours: −25 %
  PERFECT_BONUS: 0.06,             // no late call and an undamaged hull: +6 %
  PORT_STAY_H: [8, 10], SEA_KN: 17,
});
/** Net ticket income per guest-hour for a model (the old flat rate for non-cruise ids). */
export function fareOf(cls) { const c = cruiseClassOf(cls); return c ? CRUISE_FARE[c] : null; }
/** { ticket, onboard } credits of a cruise for `guests` over `hours` aboard ship `cls`: the ticket is fixed by the class
 * of the ship the cruise is sold for, the onboard spending by the venues of the ship that sails it. */
export function cruiseIncome({ guests, hours, cls, ticketCls = cls }) {
  const f = fareOf(ticketCls) ?? 20;
  return { ticket: Math.round(guests * hours * f), onboard: Math.round(guests * hours * onboardIndex(cls)) };
}
