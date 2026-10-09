// Where ships are built: yard constants, builder countries, 60 yards and the local boatyards
// (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §3). Pure data, no imports.
//
// Neutrality (§1.1): yard and country attributes are factual (location, what they build, payment practice, export-credit
// agencies) or explicit Game rules (costIdx, backlog, speed, resale, specialisation). No "quality" number anywhere. Yards
// in countries targeted by sanctions carry a location name only (politics contract P6).

export const YARD = {
  MONTH_H: 6,               // Game rule: one month of real build time = 6 hours on the world clock (Q1)
  SPECIALIST_MONTHS: 0.9,   // a yard building its speciality: production months × 0.9 …
  SPECIALIST_PRICE: 0.97,   // … price × 0.97 …
  SPECIALIST_REL: 0.03,     // … reliability + 0.03
  STOCK_PREMIUM: 1.08,      // a finished stock hull, delivered at once
  RESALE_SLOT_PREMIUM: 1.12,// buy an earlier slot: skip the backlog
  ORDER_BACKLOG_M: 1,       // each open player order at a yard adds this many months to its backlog
  DELAY: [[0.7, 0], [0.2, 0.10], [0.1, 0.25]],   // seeded per order: share of production months added
  LD_PER_MONTH: 0.005,      // liquidated damages: 0.5 % of the price per month of delay, credited at delivery
  WARRANTY_H: 720,          // Game rule (real guarantee period is 12 months [S6])
  GRACE_H: 48,              // an instalment not paid within this is a buyer default
  CANCEL_REFUND: 0.8,       // buyer cancels: first instalment lost, later paid instalments come back × 0.8
  LOCAL_MAX_LOA: 30,        // local boatyards (every regional+ harbour) build up to this length
  LOCAL_YACHT_LOA: 24,      // … yachts only up to this length
  INSPECT_FRAC: 0.002, INSPECT_MIN: 500, INSPECT_H: 2,
  JONES_PREMIUM: 1.6,       // value of a Jones-eligible ship when valued at a US harbour (Game rule, Q15)
  REPAINT_FRAC: 0.003, REPAINT_MIN: 2000, REPAINT_H: 6,
  STOCK_P: 0.6,             // Game rule: chance a stockOf model is in stock at a yard in a refresh window
  STOCK_REFRESH_H: 24,
  US_JONES_LISTING_P: 0.6,  // §3.7: at a US harbour, Jones-relevant listings are US-built with this probability
  MAX_OPEN_ORDERS: 4,       // Game rule: open orders per company (they also count toward FLEET.MAX_VESSELS, Q3)
  ORDERS_KEEP: 12,          // finished orders kept in the office record
};

export const SCHEDULES = {
  std5: [['contract', 0.20], ['steel', 0.20], ['keel', 0.20], ['launch', 0.20], ['delivery', 0.20]],   // Source [S6]
  tail: [['contract', 0.10], ['steel', 0.10], ['keel', 0.10], ['launch', 0.10], ['delivery', 0.60]],   // Source [S6] (verify)
  small: [['contract', 0.30], ['delivery', 0.70]],                                                       // Game rule
};
// milestone time = contract time + backlog months (steel cut = production start) + production share:
export const MILESTONE_AT = { contract: null, steel: 0, keel: 0.25, launch: 0.65, delivery: 1 };

// OECD Arrangement, Sector Understanding on ships: ECA cover up to 80 % for up to 12 years [S8]. China is not a party; the
// game applies the same terms. US: MARAD Title XI, up to 87.5 % for up to 25 years, US-built only [S7] (checked
// 2026-10-09: maritime.dot.gov Title XI "Financing and debt overview").
const ECA = (name) => ({ name, ltv: 0.8, years: 12 });
/** Commercial ship finance where no export-credit agency is modelled (Game rule). */
export const COMMERCIAL_LOAN = { name: 'Commercial bank (game rule)', ltv: 0.6, years: 8 };

// costIdx, backlogM, speed and resale: Game rules informed by the sources; pay: payment schedule; src: reference ids (§13).
export const YARD_COUNTRIES = {
  KR: { name: 'South Korea', costIdx: 1.00, backlogM: 10, speed: 1.00, pay: 'std5', eca: ECA('KEXIM, K-SURE'), resale: 1.03, src: ['S4', 'S5'], note: '2nd largest builder by CGT; leader in LNG carriers and large container ships' },
  CN: { name: 'China', costIdx: 0.90, backlogM: 6, speed: 1.00, pay: 'tail', eca: ECA('CEXIM, Sinosure'), resale: 0.95, src: ['S4', 'S5'], note: 'largest builder (over half of world orders by CGT in recent years); all mainstream types' },
  JP: { name: 'Japan', costIdx: 1.02, backlogM: 8, speed: 0.95, pay: 'std5', eca: ECA('JBIC, NEXI'), resale: 1.05, src: ['S4', 'S5'], note: 'bulk carriers, car carriers, chemical tankers, domestic ferries' },
  TW: { name: 'Taiwan', costIdx: 1.00, backlogM: 6, speed: 1.00, pay: 'std5', eca: null, resale: 1.00, src: ['S4'], note: 'container ships' },
  VN: { name: 'Vietnam', costIdx: 0.92, backlogM: 4, speed: 1.10, pay: 'std5', eca: null, resale: 0.97, src: ['S4'], note: 'product tankers, small bulkers, workboats' },
  PH: { name: 'Philippines', costIdx: 0.92, backlogM: 4, speed: 1.10, pay: 'std5', eca: null, resale: 0.97, src: ['S4'], note: 'bulk carriers' },
  SG: { name: 'Singapore', costIdx: 1.05, backlogM: 4, speed: 1.00, pay: 'std5', eca: null, resale: 1.00, src: ['S4'], note: 'offshore vessels and conversions' },
  IN: { name: 'India', costIdx: 0.95, backlogM: 4, speed: 1.15, pay: 'std5', eca: ECA('India Exim Bank'), resale: 0.97, src: ['S4'], note: 'workboats, small ferries' },
  TR: { name: 'Türkiye', costIdx: 1.05, backlogM: 3, speed: 0.95, pay: 'std5', eca: ECA('Türk Eximbank'), resale: 1.00, src: ['S4'], note: 'major tug exporter; fishing vessels, chemical tankers, ferries' },
  PL: { name: 'Poland', costIdx: 1.15, backlogM: 4, speed: 1.05, pay: 'std5', eca: ECA('KUKE'), resale: 1.00, src: ['S4'], note: 'ferries, offshore, hull blocks' },
  RO: { name: 'Romania', costIdx: 1.05, backlogM: 4, speed: 1.05, pay: 'std5', eca: ECA('EximBank Romania'), resale: 1.00, src: ['S4'], note: 'offshore and ferry hulls' },
  DE: { name: 'Germany', costIdx: 1.40, backlogM: 6, speed: 1.00, pay: 'std5', eca: ECA('Euler Hermes (Federal export credit)'), resale: 1.03, src: ['S4'], note: 'cruise ships, superyachts' },
  NL: { name: 'Netherlands', costIdx: 1.30, backlogM: 3, speed: 0.95, pay: 'std5', eca: ECA('Atradius DSB'), resale: 1.03, src: ['S4'], note: 'tugs and workboats, superyachts, dredgers' },
  NO: { name: 'Norway', costIdx: 1.45, backlogM: 5, speed: 1.00, pay: 'std5', eca: ECA('Eksfin'), resale: 1.03, src: ['S4'], note: 'offshore, fishing, expedition cruise' },
  FI: { name: 'Finland', costIdx: 1.40, backlogM: 10, speed: 1.00, pay: 'std5', eca: ECA('Finnvera'), resale: 1.03, src: ['S4'], note: 'cruise ships, ferries, icebreakers' },
  FR: { name: 'France', costIdx: 1.40, backlogM: 12, speed: 1.00, pay: 'std5', eca: ECA('Bpifrance Assurance Export'), resale: 1.03, src: ['S4'], note: 'cruise ships, fishing/workboats, sail yachts' },
  IT: { name: 'Italy', costIdx: 1.35, backlogM: 12, speed: 1.00, pay: 'std5', eca: ECA('SACE'), resale: 1.03, src: ['S4'], note: 'cruise ships, motor yachts' },
  ES: { name: 'Spain', costIdx: 1.25, backlogM: 4, speed: 1.00, pay: 'std5', eca: ECA('CESCE'), resale: 1.00, src: ['S4'], note: 'fishing vessels, tugs' },
  DK: { name: 'Denmark', costIdx: 1.40, backlogM: 4, speed: 1.00, pay: 'std5', eca: ECA('EIFO'), resale: 1.00, src: ['S4'], note: 'pelagic fishing vessels' },
  SE: { name: 'Sweden', costIdx: 1.40, backlogM: 3, speed: 1.00, pay: 'small', eca: ECA('EKN'), resale: 1.03, src: ['S4'], note: 'sail yachts' },
  GB: { name: 'United Kingdom', costIdx: 1.45, backlogM: 5, speed: 1.05, pay: 'std5', eca: ECA('UKEF'), resale: 1.03, src: ['S4'], note: 'motor yachts, ferries, research ships' },
  // US ×2.0 = player request and politics Q3 default; politics must NOT multiply again (§1.2).
  US: { name: 'United States', costIdx: 2.00, backlogM: 8, speed: 1.25, pay: 'std5', eca: { name: 'MARAD Title XI', ltv: 0.875, years: 25, usBuiltOnly: true }, resale: 1.00, src: ['S7'], note: 'domestic Jones Act fleet; real US-built hulls cost several times the Asian price' },
  RU: { name: 'Russia', costIdx: 1.10, backlogM: 8, speed: 1.20, pay: 'std5', eca: null, resale: 0.95, src: ['S4'], note: 'ice-class tankers; target of EU/UK/US measures' },
};
/** Local boatyards in a country not in the table (Game rule). */
export const LOCAL_DEFAULT = { name: null, costIdx: 1.10, backlogM: 2, speed: 1.00, pay: 'small', eca: null, resale: 1.00, src: [] };

/** Yard capability tags (§3.3). */
export const CAP_TAGS = ['tug', 'workboat', 'pilot', 'fishing', 'offshore', 'general', 'container_s', 'container_l', 'bulk', 'bulk_l', 'tanker_s', 'tanker_l',
  'chem', 'gas_s', 'vlgc', 'lng', 'roro', 'ferry', 'hsc', 'cruise', 'expedition', 'research', 'icebreaker', 'dredger', 'yacht_s', 'yacht_l', 'sail'];

// id, name, cc, delivery harbour, kind, builds, speciality, options, stockOf, src. `verify: true` on every row: names,
// locations and what each yard builds today must be checked before the flag is cleared (yards change owners and close).
const Y = (id, name, cc, harbor, kind, builds, spec, opts, stockOf = [], src = '') => ({ id, name, cc, harbor, kind, builds, spec, opts, stockOf, src, verify: true });
const ROWS = [
  Y('hhi_ulsan', 'HD Hyundai Heavy Industries, Ulsan', 'KR', 'ulsan', 'major', ['container_s', 'container_l', 'tanker_s', 'tanker_l', 'vlgc', 'lng', 'bulk_l', 'offshore'], ['container_l', 'lng', 'tanker_l'], ['lng', 'meoh', 'scr', 'air', 'rot'], [], 'hd-hhi.com'),
  Y('hmd_ulsan', 'HD Hyundai Mipo, Ulsan', 'KR', 'ulsan', 'major', ['tanker_s', 'chem', 'gas_s', 'container_s', 'roro'], ['tanker_s', 'chem'], ['lng', 'meoh', 'scr'], [], 'hd-hmd.com'),
  Y('hanwha_okpo', 'Hanwha Ocean, Okpo (Geoje)', 'KR', 'busan', 'major', ['lng', 'tanker_l', 'container_l', 'offshore'], ['lng', 'tanker_l'], ['lng', 'meoh', 'scr', 'air'], [], 'hanwhaocean.com'),
  Y('samsung_geoje', 'Samsung Heavy Industries, Geoje', 'KR', 'busan', 'major', ['lng', 'container_l', 'tanker_l', 'offshore'], ['lng', 'container_l'], ['lng', 'meoh', 'scr', 'air', 'rot'], [], 'samsungshi.com'),
  Y('hd_samho', 'HD Hyundai Samho, Yeongam', 'KR', 'gwangyang', 'major', ['tanker_l', 'container_l', 'bulk_l', 'lng'], ['tanker_l'], ['lng', 'scr'], [], 'hd-hsh.com'),
  Y('hudong', 'Hudong-Zhonghua (CSSC), Shanghai', 'CN', 'shanghai', 'major', ['lng', 'container_l', 'gas_s'], ['lng'], ['lng', 'scr'], [], 'cssc.net.cn'),
  Y('swb_shanghai', 'Shanghai Waigaoqiao Shipbuilding (CSSC)', 'CN', 'shanghai', 'major', ['bulk_l', 'tanker_l', 'container_l', 'cruise'], ['bulk_l'], ['lng', 'meoh', 'scr'], [], 'cssc.net.cn'),
  Y('jiangnan', 'Jiangnan Shipyard (CSSC), Shanghai', 'CN', 'shanghai', 'major', ['vlgc', 'container_l', 'gas_s', 'research', 'icebreaker'], ['vlgc'], ['lng', 'meoh', 'scr'], [], 'cssc.net.cn'),
  Y('dsic', 'Dalian Shipbuilding (CSSC)', 'CN', 'dalian', 'major', ['tanker_l', 'container_l', 'bulk_l'], ['tanker_l'], ['lng', 'meoh', 'scr'], [], 'cssc.net.cn'),
  Y('yzj', 'Yangzijiang Shipbuilding, Jiangyin', 'CN', 'shanghai', 'major', ['container_s', 'container_l', 'bulk', 'bulk_l', 'tanker_s'], ['container_s', 'bulk'], ['lng', 'meoh', 'scr'], ['handy38'], 'yzjship.com'),
  Y('cosco_hi', 'COSCO Shipping Heavy Industry, Nantong', 'CN', 'ningbo', 'major', ['bulk', 'bulk_l', 'roro', 'offshore'], ['roro'], ['lng', 'scr'], [], 'coscoshipping.com'),
  Y('gsi', 'Guangzhou Shipyard International (CSSC)', 'CN', 'guangzhou', 'major', ['ferry', 'tanker_s', 'chem', 'roro'], ['ferry'], ['lng', 'scr'], [], 'chinagsi.com'),
  Y('cmhi_weihai', 'China Merchants Jinling, Weihai', 'CN', 'qingdao', 'major', ['ferry', 'roro'], ['ferry'], ['lng', 'scr'], [], 'cmhi.com.hk'),
  Y('tsuneishi_zs', 'Tsuneishi Shipbuilding, Zhoushan', 'CN', 'ningbo', 'major', ['bulk'], ['bulk'], ['scr'], ['handy38'], 'tsuneishi.co.jp'),
  Y('imabari', 'Imabari Shipbuilding, Marugame/Saijo', 'JP', 'kobe', 'major', ['bulk', 'bulk_l', 'container_l', 'roro'], ['bulk', 'bulk_l'], ['lng', 'scr'], [], 'imabari-shipbuilding.co.jp'),
  Y('jmu_tsu', 'Japan Marine United, Tsu', 'JP', 'nagoya', 'major', ['bulk_l', 'tanker_l', 'container_l'], ['bulk_l'], ['lng', 'scr'], [], 'jmuc.co.jp'),
  Y('oshima', 'Oshima Shipbuilding, Saikai', 'JP', 'hakata', 'major', ['bulk'], ['bulk'], ['scr'], ['ultramax64'], 'osy.co.jp'),
  Y('tsuneishi_fk', 'Tsuneishi Shipbuilding, Fukuyama', 'JP', 'kobe', 'major', ['bulk'], ['bulk'], ['scr'], [], 'tsuneishi.co.jp'),
  Y('mhi_shimo', 'Mitsubishi Shipbuilding, Shimonoseki', 'JP', 'hakata', 'specialist', ['ferry', 'research'], ['ferry'], ['lng', 'hyb'], [], 'mhi.com'),
  Y('csbc', 'CSBC Corporation, Kaohsiung', 'TW', 'kaohsiung', 'major', ['container_s', 'container_l', 'bulk'], ['container_s'], ['lng', 'meoh', 'scr'], [], 'csbcnet.com.tw'),
  Y('seatrium', 'Seatrium, Singapore', 'SG', 'singapore', 'specialist', ['offshore', 'research'], ['offshore'], ['de', 'hyb'], [], 'seatrium.com'),
  Y('hd_vietnam', 'HD Hyundai Vietnam Shipbuilding, Khanh Hoa', 'VN', 'vung_tau', 'major', ['tanker_s', 'bulk', 'container_s'], ['tanker_s'], ['scr'], [], 'hd-hvs.com'),
  Y('damen_songcam', 'Damen Song Cam, Haiphong', 'VN', 'haiphong', 'specialist', ['tug', 'workboat', 'pilot', 'general'], ['tug'], ['hyb'], ['tug24', 'tug16', 'multicat27'], 'damen.com'),
  Y('tsuneishi_cebu', 'Tsuneishi Heavy Industries, Cebu', 'PH', 'cebu', 'major', ['bulk'], ['bulk'], ['scr'], ['handy38'], 'tsuneishi-cebu.com'),
  Y('subic', 'Subic Bay shipyard', 'PH', 'subic', 'major', ['bulk', 'tanker_s', 'container_s'], [], ['scr'], [], 'verify: former Hanjin Subic, now operated by Agila Subic (verify builder status)'),
  Y('cochin', 'Cochin Shipyard, Kochi', 'IN', 'kochi', 'specialist', ['workboat', 'ferry', 'tug', 'offshore'], ['ferry'], ['hyb'], [], 'cochinshipyard.in'),
  Y('sanmar', 'Sanmar Shipyards, Tuzla/Altınova', 'TR', 'istanbul', 'specialist', ['tug', 'workboat'], ['tug'], ['hyb'], ['tug24'], 'sanmar.com.tr'),
  Y('tersan', 'Tersan Shipyard, Yalova', 'TR', 'istanbul', 'specialist', ['fishing', 'ferry', 'offshore'], ['fishing'], ['hyb', 'de'], [], 'tersanshipyard.com'),
  Y('remontowa', 'Remontowa Shipbuilding, Gdańsk', 'PL', 'gdansk', 'specialist', ['ferry', 'offshore', 'tug'], ['ferry'], ['lng', 'hyb', 'de'], [], 'remontowa-rsb.pl'),
  Y('damen_galati', 'Damen Shipyards Galați', 'RO', 'constanta', 'specialist', ['offshore', 'ferry', 'dredger'], ['offshore'], ['hyb', 'de'], [], 'damen.com'),
  Y('meyer_papenburg', 'Meyer Werft, Papenburg', 'DE', 'emden', 'major', ['cruise', 'expedition', 'ferry'], ['cruise'], ['lng', 'meoh', 'air', 'de'], [], 'meyerwerft.de'),
  Y('lurssen', 'Lürssen, Bremen', 'DE', 'bremerhaven', 'yacht', ['yacht_l'], ['yacht_l'], ['hyb', 'de'], [], 'luerssen-yachts.com'),
  Y('damen_gorinchem', 'Damen Shipyards, Gorinchem', 'NL', 'rotterdam', 'specialist', ['tug', 'workboat', 'pilot', 'offshore', 'dredger', 'hsc', 'ferry'], ['tug', 'workboat', 'pilot'], ['hyb'], ['tug24', 'tug16', 'ctv26', 'multicat27', 'pilot14'], 'damen.com'),
  Y('feadship', 'Feadship (Royal Van Lent / De Vries)', 'NL', 'ijmuiden', 'yacht', ['yacht_l'], ['yacht_l'], ['hyb', 'de'], [], 'feadship.nl'),
  Y('oceanco', 'Oceanco, Alblasserdam', 'NL', 'rotterdam', 'yacht', ['yacht_l'], ['yacht_l'], ['hyb', 'de'], [], 'oceancoyacht.com'),
  Y('royal_huisman', 'Royal Huisman, Vollenhove', 'NL', 'harlingen', 'yacht', ['sail', 'yacht_l'], ['sail'], ['hyb'], [], 'royalhuisman.com'),
  Y('vard_norway', 'Vard (Fincantieri), Brattvåg/Søviknes', 'NO', 'bergen', 'specialist', ['offshore', 'fishing', 'expedition', 'research'], ['offshore', 'expedition'], ['hyb', 'de', 'lng'], [], 'vard.com'),
  Y('ulstein', 'Ulstein Verft, Ulsteinvik', 'NO', 'bergen', 'specialist', ['offshore', 'expedition', 'research'], ['offshore'], ['hyb', 'de'], [], 'ulstein.com'),
  Y('meyer_turku', 'Meyer Turku', 'FI', 'turku', 'major', ['cruise', 'ferry'], ['cruise'], ['lng', 'meoh', 'air', 'de'], [], 'meyerturku.fi'),
  Y('rmc', 'Rauma Marine Constructions', 'FI', 'turku', 'specialist', ['ferry', 'icebreaker'], ['ferry'], ['lng', 'hyb'], [], 'rmcfinland.fi'),
  Y('helsinki_sy', 'Helsinki Shipyard', 'FI', 'helsinki', 'specialist', ['icebreaker', 'expedition', 'research'], ['icebreaker'], ['de', 'hyb', 'pc'], [], 'helsinkishipyard.fi'),
  Y('chantiers_atl', "Chantiers de l'Atlantique, Saint-Nazaire", 'FR', 'saint_nazaire', 'major', ['cruise', 'ferry'], ['cruise'], ['lng', 'air', 'de'], [], 'chantiers-atlantique.com'),
  Y('piriou', 'Piriou, Concarneau', 'FR', 'brest', 'specialist', ['fishing', 'workboat', 'tug', 'research'], ['fishing'], ['hyb'], [], 'piriou.com'),
  Y('beneteau', 'Groupe Beneteau, Vendée', 'FR', 'saint_nazaire', 'yacht', ['sail', 'yacht_s'], ['sail'], ['hyb'], ['sloop', 'catamaran', 'flybridge18'], 'beneteau-group.com'),
  Y('fincantieri_mf', 'Fincantieri, Monfalcone', 'IT', 'trieste', 'major', ['cruise'], ['cruise'], ['lng', 'air', 'de'], [], 'fincantieri.com'),
  Y('fincantieri_mg', 'Fincantieri, Marghera', 'IT', 'venice', 'major', ['cruise', 'expedition'], ['cruise'], ['lng', 'air', 'de'], [], 'fincantieri.com'),
  Y('azimut_benetti', 'Azimut-Benetti, Viareggio', 'IT', 'livorno', 'yacht', ['yacht_s', 'yacht_l'], ['yacht_l'], ['hyb'], ['flybridge18', 'myacht'], 'azimutbenettigroup.com'),
  Y('ferretti', 'Ferretti Group, La Spezia', 'IT', 'la_spezia', 'yacht', ['yacht_s'], ['yacht_s'], ['hyb'], ['flybridge18', 'myacht', 'cruiser'], 'ferrettigroup.com'),
  Y('armon', 'Astilleros Armón, Vigo', 'ES', 'vigo', 'specialist', ['fishing', 'tug', 'offshore'], ['fishing'], ['hyb'], [], 'armon.es'),
  Y('karstensens', 'Karstensens Skibsværft, Skagen', 'DK', 'frederikshavn', 'specialist', ['fishing'], ['fishing'], ['hyb'], [], 'karstensen.dk'),
  Y('hallberg_rassy', 'Hallberg-Rassy, Ellös', 'SE', 'gothenburg', 'yacht', ['sail'], ['sail'], [], ['sloop', 'ketch'], 'hallberg-rassy.com'),
  Y('cammell_laird', 'Cammell Laird, Birkenhead', 'GB', 'liverpool', 'specialist', ['ferry', 'research'], ['research'], ['hyb', 'de'], [], 'clbh.co.uk'),
  Y('princess', 'Princess Yachts, Plymouth', 'GB', 'plymouth', 'yacht', ['yacht_s', 'yacht_l'], ['yacht_s'], ['hyb'], ['flybridge18'], 'princessyachts.com'),
  Y('philly', 'Philly Shipyard (Hanwha), Philadelphia', 'US', 'new_york', 'major', ['container_s', 'container_l', 'tanker_s'], ['container_s'], ['lng', 'scr'], [], 'phillyshipyard.com'),
  Y('nassco', 'General Dynamics NASSCO, San Diego', 'US', 'san_diego', 'major', ['tanker_s', 'roro', 'container_l'], ['tanker_s'], ['lng', 'scr'], [], 'nassco.com'),
  Y('bollinger', 'Bollinger Shipyards, Louisiana', 'US', 'new_orleans', 'specialist', ['offshore', 'tug', 'workboat'], ['offshore'], ['hyb'], [], 'bollingershipyards.com'),
  Y('eastern_sb', 'Eastern Shipbuilding, Panama City FL', 'US', 'tampa', 'specialist', ['tug', 'offshore', 'fishing', 'ferry'], ['tug'], ['hyb'], [], 'easternshipbuilding.com'),
  Y('conrad', 'Conrad Shipyard, Morgan City', 'US', 'new_orleans', 'specialist', ['tug', 'ferry', 'gas_s', 'dredger'], [], ['lng', 'hyb'], [], 'conradindustries.com'),
  Y('vigor', 'Vigor, Seattle/Portland', 'US', 'seattle', 'specialist', ['ferry', 'fishing', 'workboat'], ['ferry'], ['hyb'], [], 'vigor.net'),
  Y('ru_far_east', 'Bolshoy Kamen yard', 'RU', 'nakhodka', 'major', ['tanker_l', 'gas_s', 'icebreaker'], ['tanker_l'], ['lng'], [], 'location name only (politics P6)'),
];
/** The 60 seed yards keyed by id. */
export const YARDS = Object.freeze(Object.fromEntries(ROWS.map((y) => [y.id, Object.freeze({ ...y, maxLoa: null })])));
export const YARD_IDS = Object.keys(YARDS);

/** Local boatyard of a regional+ harbour (§3.4): yachts ≤ 24 m, tug16, pilot14, inshore15, rib8; hybrid option; "{Harbour} boatyard". */
export const LOCAL_MODELS = ['tug16', 'pilot14', 'inshore15', 'rib8'];
export const LOCAL_STOCK = ['rib8', 'inshore15'];
export function localYard(harbor) {
  if (!harbor || !harbor.id || harbor.size === 'minor') return null;
  const short = String(harbor.name || harbor.id).split(/[ (/]/)[0];
  return { id: `local:${harbor.id}`, name: `${short} boatyard`, cc: harbor.country || 'XX', harbor: harbor.id, kind: 'local', builds: ['local'], spec: [], opts: ['hyb'],
    stockOf: LOCAL_STOCK, maxLoa: YARD.LOCAL_MAX_LOA, src: 'generated', verify: false };
}

// Second-hand build countries (§3.7): Game rule seeded from UNCTAD/Clarksons completion shares [S4]. 'other' spreads over
// the remaining countries whose yards build the model.
export const BUILD_SHARE = {
  bulk: { CN: 0.55, JP: 0.25, KR: 0.05, PH: 0.07, VN: 0.05, other: 0.03 },
  tanker: { KR: 0.45, CN: 0.35, JP: 0.08, VN: 0.07, other: 0.05 },
  container: { CN: 0.5, KR: 0.35, JP: 0.07, TW: 0.05, other: 0.03 },
  gas: { KR: 0.6, CN: 0.25, JP: 0.12, other: 0.03 },
  lng: { KR: 0.75, CN: 0.15, JP: 0.10 },
  roro: { CN: 0.45, JP: 0.35, KR: 0.15, other: 0.05 },
  general: { CN: 0.45, NL: 0.15, VN: 0.1, TR: 0.1, other: 0.2 },
  cruise: { IT: 0.35, DE: 0.35, FR: 0.20, FI: 0.10 },
  ferry: { CN: 0.3, FI: 0.1, PL: 0.1, JP: 0.15, IT: 0.1, TR: 0.1, other: 0.15 },
  tug: { TR: 0.25, NL: 0.15, VN: 0.10, ES: 0.10, US: 0.10, CN: 0.15, JP: 0.10, other: 0.05 },
  workboat: { NL: 0.35, VN: 0.2, TR: 0.15, US: 0.1, other: 0.2 },
  pilot: { NL: 0.4, VN: 0.2, other: 0.4 },
  fishing: { NO: 0.2, ES: 0.2, TR: 0.2, DK: 0.1, FR: 0.1, US: 0.1, other: 0.1 },
  offshore: { NO: 0.3, SG: 0.15, CN: 0.2, US: 0.15, RO: 0.1, other: 0.1 },
  special: { FI: 0.2, NO: 0.2, GB: 0.15, CN: 0.15, NL: 0.15, other: 0.15 },
  motor_yacht: { IT: 0.45, NL: 0.25, GB: 0.15, DE: 0.1, other: 0.05 },
  sail_yacht: { FR: 0.55, SE: 0.2, NL: 0.15, other: 0.1 },
};
/** IACS members [S14]; RS left IACS in 2022 (shown only on RU-built ships). */
export const CLASS_SOCIETIES = ['ABS', 'BV', 'CCS', 'CRS', 'DNV', 'IRS', 'KR', 'LR', 'ClassNK', 'PRS', 'RINA', 'TL'];
export const CLASS_BY_CC = { US: 'ABS', FR: 'BV', CN: 'CCS', HR: 'CRS', NO: 'DNV', IN: 'IRS', KR: 'KR', GB: 'LR', JP: 'ClassNK', PL: 'PRS', IT: 'RINA', TR: 'TL', RU: 'RS' };
/** Flags drawn for second-hand flag histories (open registers first; Game rule weights). */
export const HISTORY_FLAGS = [['PA', 0.18], ['LR', 0.18], ['MH', 0.14], ['MT', 0.08], ['BS', 0.06], ['SG', 0.06], ['HK', 0.06], ['CY', 0.04], ['NO', 0.03],
  ['GR', 0.03], ['GB', 0.03], ['NL', 0.03], ['DK', 0.02], ['PT', 0.02], ['JP', 0.02], ['CN', 0.02]];
/** §3.7: at a US harbour, listings of these are US-built with probability YARD.US_JONES_LISTING_P. */
export const JONES_TYPES = new Set(['tug', 'workboat', 'offshore', 'ferry', 'fishing']);
