// Inline SVG icon set (docs/V4-CONTRACTS.md §2). 24 × 24 line icons drawn with `currentColor`, so they take the colour and
// size of the surrounding text (CSS: `.ic { width: 1.25em; height: 1.25em }`). Plain strings — no DOM, no imports — so
// the module also loads under Node for tests. `ic(name, cls)` adds an extra class; `GOOD_ICON` / `JOB_ICON` / `CAT_ICON`
// map game ids to icon names.

const svg = (body, extra = '') =>
  `<svg class="ic${extra}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const P = {
  // ------------------------------------------------------------------ nautical / game
  anchor: '<circle cx="12" cy="5" r="2.2"/><path d="M12 7.2V21"/><path d="M8.5 10.5h7"/><path d="M5 12.5H3a9 9 0 0 0 18 0h-2"/>',
  ship: '<path d="M3 14.5h18l-2.2 4.6a2 2 0 0 1-1.8 1.1H7a2 2 0 0 1-1.8-1.1L3 14.5z"/><path d="M6 14.5V10h8.5l3 4.5"/><path d="M8.5 10V6.5h4V10"/><path d="M10.5 6.5V3.5"/>',
  yacht: '<path d="M3 15.5h18l-3 4H6l-3-4z"/><path d="M6 15.5l2.5-4h7l3 4"/><path d="M10 11.5l1.5-2.5h3l1.5 2.5"/>',
  sail: '<path d="M12 3v14"/><path d="M12 4.5l7 11.5h-7"/><path d="M10.5 7L5 16h5.5"/><path d="M3 19.5c2.5 1.4 15.5 1.4 18 0"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12"/><path d="M6.5 7h5v4h-5z"/><path d="M14 9h2a2 2 0 0 1 2 2v4.5a1.5 1.5 0 0 0 3 0V8.5L18 5.5"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z"/>',
  chart: '<path d="M3 6.5l6-3 6 3 6-3v14l-6 3-6-3-6 3v-14z"/><path d="M9 3.5v14M15 6.5v14"/>',
  crate: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5v-9z"/><path d="M3 7.5l9 4.5 9-4.5"/><path d="M12 12v9"/><path d="M7.5 5.2l9 4.6"/>',
  coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  person: '<circle cx="12" cy="7.5" r="3.8"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  warning: '<path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5"/><path d="M12 17.2v.1"/>',
  wind: '<path d="M3 8.5h10a3 3 0 1 0-3-3"/><path d="M3 12.5h14.5a3 3 0 1 1-3 3"/><path d="M3 16.5h7"/>',
  wave: '<path d="M2 8c2.5-2.5 5-2.5 7 0s4.5 2.5 7 0 4.5-2.5 6 0"/><path d="M2 13c2.5-2.5 5-2.5 7 0s4.5 2.5 7 0 4.5-2.5 6 0"/><path d="M2 18c2.5-2.5 5-2.5 7 0s4.5 2.5 7 0 4.5-2.5 6 0"/>',
  tide: '<path d="M12 3v11"/><path d="M9 6l3-3 3 3"/><path d="M9 11l3 3 3-3"/><path d="M2 19c2.5-2 5-2 7 0s4.5 2 7 0 4.5-2 6 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z"/>',
  gauge: '<path d="M3.5 17.5a9 9 0 1 1 17 0"/><path d="M12 15l4.5-5.5"/><circle cx="12" cy="15.5" r="1.4"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z"/>',
  route: '<circle cx="6" cy="18.5" r="2.2"/><circle cx="18" cy="5.5" r="2.2"/><path d="M8.2 18.5H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.8"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6.4-6.4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  camera: '<path d="M4 7.5h3l1.8-2.5h6.4L17 7.5h3a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.2" r="3.6"/>',
  walk: '<circle cx="13.5" cy="4" r="2"/><path d="M10 21l2.2-6.2 2.8 2.7V21"/><path d="M7 12.5l2.8-4h4.2l2.2 3.8 2.8 1"/><path d="M9.8 8.5l2.4 6.3"/>',
  stairs: '<path d="M3 20h5v-5h5v-5h5V5h3"/><path d="M3 20V9"/>',
  door: '<path d="M14 21H5V4a1 1 0 0 1 1-1h8"/><path d="M3 21h11"/><path d="M10.5 12.5h.1"/><path d="M15 12h6.5"/><path d="M18.5 9l3 3-3 3"/>',
  gangway: '<path d="M2 18h6l8-7h6"/><path d="M5 18v3M11 13.5V17M17 11v3"/><circle cx="16" cy="4.5" r="1.8"/><path d="M16 6.3v3.2"/>',
  pier: '<path d="M2 14h20"/><path d="M5 14v7M12 14v7M19 14v7"/><path d="M9 14V9.5h6V14"/><path d="M10.5 9.5V7h3v2.5"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6"/>',
  buoy: '<path d="M12 2.5v4"/><path d="M9 6.5h6l2 9H7l2-9z"/><path d="M8 11h8"/><path d="M2 19c2.5-1.8 5-1.8 7 0s4.5 1.8 7 0 4.5-1.8 6 0"/>',
  lighthouse: '<path d="M9 21l1.2-12h3.6L15 21"/><path d="M8.5 9h7"/><path d="M10 9V6.5a2 2 0 0 1 4 0V9"/><path d="M12 3v1.5"/><path d="M4 6.5l3 1M20 6.5l-3 1"/><path d="M6 21h12"/>',
  crane: '<path d="M6 21V4h2"/><path d="M6 4h14l-6 3.5"/><path d="M17.5 4v6"/><path d="M15.5 10h4v3h-4z"/><path d="M3 21h10"/><path d="M6 8l2-4M6 12l2-4M6 16l2-4"/>',
  shipyard: '<path d="M5 21V4h2"/><path d="M5 4h14l-5 3.5"/><path d="M17 4v5"/><path d="M2 21h20"/><path d="M9 17.5h11l-1.5 3.5h-8z"/><path d="M12 17.5v-3h4v3"/>',
  market: '<path d="M4 10.5V20h16v-9.5"/><path d="M3 10.5L5 4h14l2 6.5"/><path d="M3 10.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M10 20v-5h4v5"/>',
  board: '<rect x="3" y="3.5" width="18" height="13" rx="1.5"/><path d="M7.5 21l1.8-4.5M16.5 21l-1.8-4.5"/><path d="M7 7.5h6M7 10.5h10M7 13.5h4"/>',
  contract: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4"/><path d="M8.5 9.5h7M8.5 13h7M8.5 16.5h4"/>',
  mask: '<path d="M2.5 8.5c3-2 6.5-2 9.5 0 3-2 6.5-2 9.5 0 0 5.5-3 8.5-6.2 8.5-2 0-3.3-2-3.3-2s-1.3 2-3.3 2c-3.2 0-6.2-3-6.2-8.5z"/><path d="M6.5 11.2h2.5M15 11.2h2.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  handshake: '<path d="M7 7.5h11.5L15.5 4.5"/><path d="M17 16.5H5.5l3 3"/>',
  skull: '<path d="M12 3a7 7 0 0 0-7 7c0 2.6 1.3 4.2 3 5.1V18h8v-2.9c1.7-.9 3-2.5 3-5.1a7 7 0 0 0-7-7z"/><circle cx="9.4" cy="10.5" r="1.4"/><circle cx="14.6" cy="10.5" r="1.4"/><path d="M10 18v3M14 18v3"/>',
  tow: '<path d="M12 2.5v6.5"/><path d="M8.5 9h7"/><path d="M12 9v4"/><path d="M12 13a4 4 0 1 0 4 4"/><path d="M16 17l-1.8-1.6M16 17l1.6-1.8"/>',
  kit: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v2"/><path d="M12 10.5v6M9 13.5h6"/>',
  fish: '<path d="M2.5 12c3.2-5 9.3-6.2 14-2l4.5-3.2v10.4L16.5 14c-4.7 4.2-10.8 3-14-2z"/><circle cx="7.5" cy="11" r=".9" fill="currentColor"/>',
  net: '<path d="M3 4l9 16 9-16"/><path d="M5.2 8h13.6M7.4 12h9.2M9.6 16h4.8"/><path d="M8 4l4 16 4-16"/>',
  platform: '<path d="M4 10h16"/><path d="M6.5 10L4 21M17.5 10L20 21"/><path d="M8 10V6h5v4"/><path d="M15.5 10V3"/><path d="M15.5 3l2.5 1.5"/><path d="M5.3 15.5h13.4"/>',
  storm: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
  rain: '<path d="M12 3s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11z"/>',
  cloud: '<path d="M7 18.5h10a4.5 4.5 0 0 0 .6-9A6 6 0 0 0 6.2 10.6 4 4 0 0 0 7 18.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  thermo: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  pressure: '<circle cx="12" cy="12" r="9"/><path d="M12 12l4-4"/><path d="M7 15.5h10"/>',
  visibility: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 20L20 4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4.5h12l-2.5 4 2.5 4H5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  seamark: '<path d="M12 2.5v4"/><path d="M9 6.5h6l2 9H7l2-9z"/><path d="M2 19c2.5-1.8 5-1.8 7 0s4.5 1.8 7 0 4.5-1.8 6 0"/>',
  // ------------------------------------------------------------------ cargo types
  grain: '<path d="M12 21V9.5"/><path d="M12 9.5c-2-1-3-3-3-5.5 2 1 3 3 3 5.5zM12 9.5c2-1 3-3 3-5.5-2 1-3 3-3 5.5z"/><path d="M12 14.5c-2.2-.8-3.6-2.6-3.6-4.8 2 .6 3.6 2.4 3.6 4.8zM12 14.5c2.2-.8 3.6-2.6 3.6-4.8-2 .6-3.6 2.4-3.6 4.8z"/><path d="M12 19c-2.2-.8-3.6-2.6-3.6-4.8 2 .6 3.6 2.4 3.6 4.8zM12 19c2.2-.8 3.6-2.6 3.6-4.8-2 .6-3.6 2.4-3.6 4.8z"/>',
  steel: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2.5"/>',
  machinery: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  containers: '<rect x="2.5" y="13.5" width="19" height="6"/><rect x="5" y="7.5" width="14" height="6"/><path d="M7 15.5v2M10 15.5v2M14 15.5v2M17 15.5v2M9 9.5v2M12 9.5v2M15 9.5v2"/><path d="M8 7.5V4.5h8v3"/>',
  barrel: '<path d="M6.5 3.5h11M6.5 20.5h11"/><path d="M7.5 3.5c-1.8 5.5-1.8 11.5 0 17M16.5 3.5c1.8 5.5 1.8 11.5 0 17"/><path d="M6 9h12M6 15h12"/>',
  supplies: '<rect x="3" y="9" width="8" height="8"/><rect x="13" y="9" width="8" height="8"/><rect x="8" y="3" width="8" height="6"/><path d="M2 20h20"/><path d="M5 17v3M19 17v3M12 17v3"/>',
  cigarettes: '<rect x="2" y="13" width="17" height="4" rx="1"/><path d="M15 13v4"/><path d="M21 13v4"/><path d="M18 10c0-1.6 2-1.6 2-3.2M15.5 10c0-1.6 2-1.6 2-3.2"/>',
  weapons: '<rect x="3" y="7" width="18" height="12" rx="1.5"/><path d="M3 11h18"/><path d="M10 15h4"/><path d="M8 7V5h8v2"/>',
  narcotics: '<path d="M10.5 20.5a5 5 0 0 1-7-7l6.5-6.5a5 5 0 0 1 7 7z"/><path d="M7 10.5l6.5 6.5"/><path d="M17 3.5l3.5 3.5M15.5 5l3.5 3.5"/>',
  antiquities: '<path d="M9 3h6"/><path d="M10 3v2.8C7 7 5.5 10 5.5 13.5 5.5 18 8.5 21 12 21s6.5-3 6.5-7.5C18.5 10 17 7 14 5.8V3"/><path d="M6.5 12h11"/><path d="M8 16h8"/>',
  // ------------------------------------------------------------------ UI
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M4.5 12.5l5 5L20 7"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronUp: '<path d="M5 15l7-7 7 7"/>',
  chevronDown: '<path d="M5 9l7 7 7-7"/>',
  arrowUp: '<path d="M12 20V4"/><path d="M5.5 10.5L12 4l6.5 6.5"/>',
  arrowDown: '<path d="M12 4v16"/><path d="M5.5 13.5L12 20l6.5-6.5"/>',
  arrowRight: '<path d="M4 12h16"/><path d="M13.5 5.5L20 12l-6.5 6.5"/>',
  trendUp: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  trendDown: '<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
  trendFlat: '<path d="M3 12h18"/><path d="M16 7l5 5-5 5"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.1M4 12h.1M4 18h.1"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.5 2.5 0 1 1 3.4 2.4c-.6.3-.9.8-.9 1.4V14"/><path d="M12 17.2v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.1"/>',
  ffwd: '<path d="M3.5 6.5l8 5.5-8 5.5v-11z"/><path d="M12.5 6.5l8 5.5-8 5.5v-11z"/>',
  rewind: '<path d="M20.5 6.5l-8 5.5 8 5.5v-11z"/><path d="M11.5 6.5l-8 5.5 8 5.5v-11z"/>',
  play: '<path d="M7 4.5l13 7.5-13 7.5v-15z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/>',
  pointer: '<path d="M5 3l14 7.2-6.2 1.8L10.5 19 5 3z"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  compare: '<rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/><path d="M6.7 9h.1M17.2 9h.1"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/>',
  speed: '<path d="M3.5 17.5a9 9 0 1 1 17 0"/><path d="M12 15l3.5-6"/><path d="M6 17.5h12"/>',
  range: '<path d="M3 12h18"/><path d="M6 8l-3 4 3 4M18 8l3 4-3 4"/>',
  hold: '<path d="M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8z"/><path d="M3 8l2-4h14l2 4"/><path d="M9 12h6"/>',
  signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
  chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  dollar: '<path d="M12 3v18"/><path d="M16.5 7.5c0-1.9-2-3-4.5-3s-4.5 1.2-4.5 3.2c0 4.3 9 2.3 9 6.8 0 2-2 3.5-4.5 3.5s-4.5-1.2-4.5-3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  hourglass: '<path d="M6 3h12M6 21h12"/><path d="M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/>',
  hull: '<path d="M2.5 9h19l-2.6 8.2a2 2 0 0 1-1.9 1.3H7a2 2 0 0 1-1.9-1.3L2.5 9z"/><path d="M6.5 12.5h11"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3"/><path d="M17 6l3 3M15 8l2 2"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};

/** `ICON.anchor` → '<svg class="ic" …>…</svg>' */
export const ICON = Object.freeze(Object.fromEntries(Object.entries(P).map(([k, body]) => [k, svg(body)])));

/** Icon string with an extra class (e.g. `ic('anchor', 'lg')` → class="ic lg"); unknown names fall back to `info`. */
export function ic(name, cls = '') { return svg(P[name] || P.info, cls ? ' ' + cls : ''); }

/** Commodity id → icon name. */
export const GOOD_ICON = Object.freeze({
  fish: 'fish', grain: 'grain', steel: 'steel', machinery: 'machinery', containers: 'containers', fuel: 'barrel', supplies: 'supplies',
  cigarettes: 'cigarettes', weapons: 'weapons', narcotics: 'narcotics', antiquities: 'antiquities',
});
/** Contract type → icon name. */
export const JOB_ICON = Object.freeze({
  freight: 'crate', passengers: 'users', charter: 'yacht', fishing: 'fish', supply: 'platform', tow: 'tow', smuggling: 'mask',
});
/** Ship market category → icon name. */
export const CAT_ICON = Object.freeze({ working: 'crane', cargo: 'containers', passenger: 'users', 'motor yacht': 'yacht', 'sailing yacht': 'sail' });

/** CSS `url()` value of an icon (for backgrounds / placeholders), in a given colour. */
export function iconDataUrl(name, color = '#8fb0c8') {
  const s = svg(P[name] || P.info).replace('stroke="currentColor"', `stroke="${color}"`).replace(/fill="currentColor"/g, `fill="${color}"`).replace(' class="ic"', '');
  return `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
}
