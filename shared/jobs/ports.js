// Harbour tags and port limits (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §2.6, §5.6). Data + pure lookups.
// Every seed row is `verify: true` until the data lane checks it; `src` names the kind of reference.
// Plain ESM, browser-safe. A harbour is the game's harbour object ({ id, name, size, country, lat, lon }).

/** Default tags by harbour size (§5.6). */
export const SIZE_TAGS = {
  mega: ['container', 'products', 'roro', 'bulk_grain', 'heavy', 'cruise', 'marina', 'bunkers'],
  major: ['container', 'products', 'bulk_grain', 'roro', 'marina'],
  regional: ['products', 'bulk_grain', 'ferry', 'marina', 'fishing'],
  minor: ['fishing', 'marina', 'ferry'],
};
/** §2.6 maximum length overall by size (Game rule). */
export const SIZE_MAX_LOA = { mega: 400, major: 366, regional: 250, minor: 140 };

// §5.6 seed table: tag → harbour ids (a→b: real port not in the game, tag on the nearest game harbour b).
export const TAG_SEEDS = {
  bulk_ore: ['port_hedland', 'dampier', 'itaguai', 'vitoria', 'sohar', 'saldanha', 'narvik', 'sept_iles', 'qingdao', 'dalian'],
  bulk_coal: ['newcastle_au', 'hay_point', 'gladstone', 'richards_bay', 'vancouver', 'nakhodka', 'balikpapan'],
  bulk_grain: ['santos', 'paranagua', 'rio_grande', 'bahia_blanca', 'new_orleans', 'odesa', 'novorossiysk', 'constanta', 'vancouver'],
  oil: ['ras_tanura', 'kharg', 'fujairah', 'novorossiysk', 'ust_luga', 'bonny', 'milford_haven', 'wilhelmshaven', 'rotterdam', 'corpus_christi', 'galveston', 'sohar', 'umm_qasr'],
  lng: ['ras_laffan', 'bintulu', 'hammerfest', 'gladstone', 'bonny', 'dampier', 'zeebrugge', 'rotterdam', 'galveston', 'ningbo', 'incheon', 'tokyo'],
  lpg: ['ras_tanura', 'ras_laffan', 'galveston', 'fujairah', 'ulsan'],
  chem: ['rotterdam', 'antwerp', 'galveston', 'singapore', 'ulsan', 'ningbo'],
  cars: ['zeebrugge', 'bremerhaven', 'southampton', 'antwerp', 'nagoya', 'ulsan', 'baltimore', 'los_angeles'],
  cruise: ['southampton', 'barcelona', 'civitavecchia', 'piraeus', 'miami', 'kiel', 'copenhagen', 'bergen', 'palma', 'singapore', 'sydney', 'vancouver', 'ushuaia'],
  offshore: ['aberdeen', 'stavanger', 'bergen', 'esbjerg', 'den_helder', 'galveston', 'new_orleans', 'kemaman', 'rio_de_janeiro', 'dampier'],
  windfarm: ['esbjerg', 'eemshaven', 'ostend', 'lowestoft', 'immingham', 'cuxhaven', 'vlissingen'],
  fishing: ['peterhead', 'lerwick', 'tromso', 'hammerfest', 'vigo', 'dutch_harbor', 'kodiak', 'nouadhibou', 'mar_del_plata', 'chimbote', 'torshavn', 'reykjavik', 'las_palmas', 'manta', 'petropavlovsk', 'harlingen', 'hirtshals', 'lowestoft'],
  livestock: ['fremantle', 'darwin', 'broome', 'port_hedland'],
  ice: ['lulea', 'helsinki', 'kotka', 'turku', 'st_petersburg', 'ust_luga', 'tallinn', 'quebec', 'sept_iles'],
  heavy: ['rotterdam', 'antwerp', 'hamburg', 'bremerhaven', 'ulsan', 'busan', 'shanghai', 'singapore', 'galveston'],
  bunkers: ['singapore', 'fujairah', 'rotterdam', 'gibraltar', 'algeciras', 'panama_colon', 'balboa', 'las_palmas', 'hong_kong', 'busan'],
  dredge: ['rotterdam', 'antwerp', 'hamburg', 'new_orleans', 'shanghai', 'chittagong', 'haldia', 'buenos_aires'],
  // Lane D addition (Game rule, verify): yachting hubs whose marina work dominates the board.
  marina: ['palma'],
  research: ['bergen', 'hobart', 'ushuaia', 'nuuk', 'tromso', 'reykjavik', 'southampton'],
};
/** Harbours named in a seed row are specialists in that tag: its family weights × this (Game rule). */
export const SEED_WEIGHT_MUL = 4;

/**
 * Per-harbour overrides (§2.6 / §5.6): `tags` replaces the size defaults for single-purpose ports (Game rule, verify),
 * `maxLoa`, `maxDraft` (m at the deepest berth), `vloc` (takes 400k ore carriers), `lng` (LNG bunkers).
 */
export const PORTS = {
  port_hedland: { tags: ['bulk_ore', 'livestock', 'products'], src: 'Pilbara Ports Authority (verify)', verify: true },
  dampier: { tags: ['bulk_ore', 'lng', 'offshore', 'products'], src: 'Pilbara Ports Authority (verify)', verify: true },
  hay_point: { tags: ['bulk_coal'], src: 'North Queensland Bulk Ports (verify)', verify: true },
  ras_tanura: { tags: ['oil', 'lpg', 'products'], src: 'Saudi Aramco (verify)', verify: true },
  kharg: { tags: ['oil'], src: 'trade reference (verify)', verify: true },
  ras_laffan: { tags: ['lng', 'lpg'], lng: true, src: 'QatarEnergy (verify)', verify: true },
  bintulu: { tags: ['lng', 'products'], lng: true, src: 'trade reference (verify)', verify: true },
  palma: { tags: ['ferry', 'marina', 'cruise', 'products'], src: 'Ports de Balears (verify)', verify: true },
  itaguai: { vloc: true, src: 'Vale (verify)', verify: true }, vitoria: { vloc: true, src: 'Vale (verify)', verify: true },
  sohar: { vloc: true, src: 'Vale (verify)', verify: true }, qingdao: { vloc: true, src: 'trade reference (verify)', verify: true },
  dalian: { vloc: true, src: 'trade reference (verify)', verify: true },
  rotterdam: { lng: true, vloc: true, maxDraft: 23.5, src: 'Port of Rotterdam (verify)', verify: true },
  singapore: { lng: true, src: 'MPA Singapore (verify)', verify: true },
  zeebrugge: { lng: true, src: 'Port of Zeebrugge (verify)', verify: true },
  lowestoft: { maxLoa: 140, src: 'Associated British Ports (verify)', verify: true },
  hull: { maxDraft: 12.0, src: 'Associated British Ports (verify)', verify: true },
};

const tagCache = new Map();
/** The harbour's tag set (defaults by size, or the override's full list, plus every seed row naming it). */
export function tagsOf(h) {
  if (!h) return new Set();
  const key = h.id;
  if (tagCache.has(key)) return tagCache.get(key);
  const o = PORTS[h.id];
  const s = new Set(o?.tags || SIZE_TAGS[h.size] || SIZE_TAGS.minor);
  for (const [tag, ids] of Object.entries(TAG_SEEDS)) if (ids.includes(h.id)) s.add(tag);
  tagCache.set(key, s);
  return s;
}
export function hasTag(h, tag) { return tagsOf(h).has(tag); }
/** Is `h` named in the seed row of `tag` (a specialist port for it)? */
export function isSeed(h, tag) { return !!h && (TAG_SEEDS[tag] || []).includes(h.id); }
/** Port limits: { maxLoa, maxDraft (null = unknown), vloc, lng }. */
export function limitsOf(h) {
  const o = (h && PORTS[h.id]) || {};
  return { maxLoa: o.maxLoa ?? SIZE_MAX_LOA[h?.size] ?? SIZE_MAX_LOA.minor, maxDraft: o.maxDraft ?? null, vloc: !!o.vloc, lng: !!o.lng || hasTag(h, 'lng') };
}
/** Short display name ('Rotterdam (Maasvlakte)' → 'Rotterdam'; 'IJmuiden / Amsterdam' → 'IJmuiden'). */
export function shortName(h) { return String(h?.name || h?.id || '').split(/\s[(/]/)[0].trim(); }
