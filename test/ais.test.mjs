// Live AIS (server/ais/*): decoders, MID flags, destination resolution, class mapping, dead reckoning, stale removal,
// origin inference, spatial queries and their speed, and both sources (AISStream WebSocket, Digitraffic REST) driven by
// injected fakes. No network.
//
// test/fixtures/ais/aisstream-live.json holds REAL AISStream frames, verbatim (2026-10-07 and 2026-10-08). The other
// fixtures are hand-written in the documented wire formats; the Digitraffic metadata record of 538012359 'AGIA DIMITRA'
// is the real one returned by /api/ais/v1/vessels on 2026-10-07 (its position in the locations fixture is made up).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toLocal } from '../shared/geo.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { HARBORS } from '../server/harbors.js';
import { flagOf, mmsiKind, midOf, MID } from '../server/ais/mid.js';
import { createPortIndex, builtinPorts, normalizeText } from '../server/ais/ports.js';
import {
  AisStore, decodeRot, decodeEta, decodePackedEta, dimsFrom, draughtFromDm, draughtFromM, cleanSog, cleanCog, cleanHeading, cleanText, cleanName, classFor,
  deadReckon, LIMITS, fmtEta,
} from '../server/ais/store.js';
import { parseAisStreamMessage, parseTimeUtc, boxesFor, AisStreamSource, MESSAGE_TYPES, DETAIL_BOX, GLOBAL_BOXES, readApiKey } from '../server/ais/aisstream.js';
import { parseLocations, parseVessels, DigitrafficSource } from '../server/ais/digitraffic.js';
import { LiveAis } from '../server/ais/index.js';

const FIX = new URL('./fixtures/ais/', import.meta.url);
const fx = (name) => JSON.parse(fs.readFileSync(new URL(name, FIX), 'utf8'));
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0); // 2026-10-07 12:00:00 UTC — the fixtures are a few seconds older
const ports = createPortIndex(HARBORS);
const mkStore = (now = NOW) => new AisStore({ ports, now: () => now });
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);

/** Deterministic timers + clock: timers fire only from advance(). */
function fakeClock(start = NOW) {
  let now = start, seq = 0;
  const q = [];
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) { const h = { id: ++seq, at: now + Math.max(0, ms || 0), fn }; q.push(h); return h; },
      clearTimeout(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        const h = q[0];
        if (!h || h.at > end) break;
        q.shift(); now = h.at;
        await h.fn(); await flush(); await flush();
      }
      now = end;
      await flush();
    },
    pending: () => q.map((h) => h.at - now),
    flush,
  };
}

/** Minimal WebSocket stand-in (on* handler API, as used with both `ws` and the WHATWG WebSocket). */
function fakeWsClass() {
  const instances = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; instances.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.closed = true; if (this.onclose) this.onclose({ code: 1000 }); }
    // test helpers
    open() { if (this.onopen) this.onopen({}); }
    msg(obj) { if (this.onmessage) this.onmessage({ data: Buffer.from(JSON.stringify(obj)) }); }
    fail(code = 1006) { this.closed = true; if (this.onclose) this.onclose({ code, reason: 'abnormal' }); }
  }
  FakeWS.instances = instances;
  return FakeWS;
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [re, h] of routes) if (re.test(url)) {
      const r = await h(url, init);
      if (r instanceof Error) throw r;
      return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

// ------------------------------------------------------------------------------------------------ decoders
describe('decoders', () => {
  test('rate of turn: AIS ROT encoding → °/min', () => {
    assert.equal(decodeRot(-128), null);
    assert.equal(decodeRot(null), null);
    assert.equal(decodeRot(0), 0);
    assert.equal(decodeRot(127), 10);
    assert.equal(decodeRot(-127), -10);
    close(decodeRot(15), 10.0, 0.1, 'ROT_AIS 15');            // 4.733·√10 ≈ 15 → 10 °/min
    close(decodeRot(-4), -0.7, 0.05, 'ROT_AIS -4');
    close(decodeRot(126), 708, 1, 'ROT_AIS 126');
  });
  test('sog / cog / heading "not available" values', () => {
    assert.equal(cleanSog(102.3), null);
    assert.equal(cleanSog(102.2), null); // "102.2 kn or more" is not a usable speed either
    assert.equal(cleanSog(13.4), 13.4);
    assert.equal(cleanCog(360), null);
    assert.equal(cleanCog(359.9), 359.9);
    assert.equal(cleanHeading(511), null);
    assert.equal(cleanHeading(0), 0);
  });
  test('dimensions and draught', () => {
    assert.deepEqual(dimsFrom(154, 26, 20, 10), { length: 180, beam: 30 });
    assert.deepEqual(dimsFrom(0, 0, 0, 0), { length: null, beam: null });
    assert.deepEqual(dimsFrom(10, 2, 2, 2), { length: 12, beam: 4 });
    assert.deepEqual(dimsFrom(0, 3, 5, 5), { length: 3, beam: null }); // beam wider than the hull is long: not a beam
    assert.equal(draughtFromDm(101), 10.1);
    assert.equal(draughtFromDm(0), null);
    assert.equal(draughtFromDm(255), null);
    assert.equal(draughtFromM(4), 4); assert.equal(draughtFromM(7.8), 7.8); assert.equal(draughtFromM(78), 7.8); // decimetres
    assert.equal(draughtFromM(25.5), null); assert.equal(draughtFromM(0), null); // "25.5 m or more" placeholder, n/a
  });
  test('ship names: underscores, line noise from corrupted receptions (seen live)', () => {
    assert.equal(cleanName('SCORPIO_2'), 'SCORPIO 2'); assert.equal(cleanName('NIEDERHEIMBACH_LORCH'), 'NIEDERHEIMBACH LORCH');
    assert.equal(cleanName('CYANNE -99%'), 'CYANNE -99%'); assert.equal(cleanName("ST. MARY'S"), "ST. MARY'S");
    assert.equal(cleanName('H HE&H.\'_(WS!C?" !L'), null); assert.equal(cleanName('R???M'), null); assert.equal(cleanName('@@@@'), null);
    const s = mkStore();
    s.upsertStatic(244000050, { name: 'R???M', aisType: 70 }, NOW);
    s.upsertPosition(244000050, { lat: 52, lon: 4, sog: 1, cog: 0, nav: 0, t: NOW, name: 'ROSSUM' }, NOW);
    assert.equal(s.get(244000050, NOW).name, 'ROSSUM'); // the envelope name, not the noise
  });
  test('text fields: padding, control characters and junk at the ends', () => {
    assert.equal(cleanText('NOORDZEE TRADER@@@@@'), 'NOORDZEE TRADER');
    assert.equal(cleanText('BENTHE   '), 'BENTHE');
    assert.equal(cleanText('EILTANK 250 _'), 'EILTANK 250');      // seen live
    assert.equal(cleanText('ST. MARY.'), 'ST. MARY.');
    for (const junk of ['@@@@@@@@@@@@@@@@@@@@', '-', '____', '*', '.....', '----------------', '  ']) assert.equal(cleanText(junk), null, junk);
  });
  test('ETA: month/day/hour/minute with year inference, packed form, n/a values', () => {
    assert.equal(decodeEta(10, 8, 14, 30, NOW), Date.UTC(2026, 9, 8, 14, 30));
    assert.equal(decodeEta(0, 8, 14, 30, NOW), null);
    assert.equal(decodeEta(10, 0, 14, 30, NOW), null);
    assert.equal(decodeEta(10, 9, 24, 60, NOW), Date.UTC(2026, 9, 9, 0, 0)); // hour/minute n/a → midnight
    assert.equal(decodeEta(2, 30, 0, 0, NOW), null);                         // 30 February
    assert.equal(decodeEta(1, 5, 6, 0, Date.UTC(2026, 11, 20)), Date.UTC(2027, 0, 5, 6, 0));   // January seen in December
    assert.equal(decodeEta(12, 28, 10, 0, Date.UTC(2027, 0, 3)), Date.UTC(2026, 11, 28, 10, 0)); // December seen in January
    assert.equal(decodeEta(4, 7, 1, 0, Date.UTC(2026, 9, 8)), Date.UTC(2026, 3, 7, 1, 0));      // stale April ETA seen live in October
    assert.equal(decodeEta(12, 1, 6, 0, Date.UTC(2026, 9, 8)), Date.UTC(2026, 11, 1, 6, 0));     // 7 weeks ahead: this year
    assert.equal(decodeEta(2, 29, 6, 0, Date.UTC(2026, 9, 8)), null);                            // no 29 February in 2026
    assert.equal(decodePackedEta(672128, NOW), Date.UTC(2026, 9, 8, 6, 0)); // 10<<16 | 8<<11 | 6<<6
    assert.equal(decodePackedEta(0, NOW), null);
    assert.equal(fmtEta(Date.UTC(2026, 9, 8, 6, 0)), '08 Oct 06:00 UTC');
  });
  test('AISStream time_utc', () => {
    assert.equal(parseTimeUtc('2026-10-07 11:59:30.512345 +0000 UTC'), Date.UTC(2026, 9, 7, 11, 59, 30, 512));
    assert.equal(parseTimeUtc('garbage'), null);
  });
});

// ------------------------------------------------------------------------------------------------ MID
describe('MID → flag', () => {
  test('ship stations', () => {
    assert.equal(flagOf(538012359), 'MH'); // AGIA DIMITRA, Marshall Islands
    assert.equal(flagOf(244670587), 'NL');
    assert.equal(flagOf(211987654), 'DE');
    assert.equal(flagOf(232001234), 'GB');
    assert.equal(flagOf(257123000), 'NO');
    assert.equal(flagOf(230123450), 'FI');
    assert.equal(flagOf(636092000), 'LR');
    assert.equal(flagOf(351234000), 'PA');
    assert.equal(flagOf(477123400), 'HK');
    assert.equal(flagOf(219000001), 'DK');
    assert.equal(flagOf(265123456), 'SE');
    assert.equal(flagOf(276123456), 'EE');
    assert.equal(flagOf(273000000), 'RU');
    assert.equal(flagOf(503000000), 'AU');
    assert.equal(flagOf(775000000), 'VE');
  });
  test('other MMSI formats and unallocated MIDs', () => {
    assert.equal(mmsiKind(992446001), 'aton'); assert.equal(midOf(992446001), 244); assert.equal(flagOf(992446001), 'NL');
    assert.equal(mmsiKind(2440001), 'coast'); assert.equal(flagOf(2440001), 'NL');            // 002440001
    assert.equal(mmsiKind(24400012), 'group'); assert.equal(flagOf(24400012), 'NL');          // 024400012
    assert.equal(mmsiKind(111232501), 'sar-aircraft'); assert.equal(flagOf(111232501), 'GB');
    assert.equal(mmsiKind(982440123), 'craft'); assert.equal(flagOf(982440123), 'NL');
    assert.equal(mmsiKind(970123456), 'sart'); assert.equal(flagOf(970123456), null);
    assert.equal(flagOf(200000000), null); // MID 200 unallocated
    assert.equal(flagOf('abc'), null);
  });
  test('table is complete enough: every allocated block 201–775, ISO-2 codes', () => {
    assert.ok(MID.size >= 280, `MID entries: ${MID.size}`);
    for (const [mid, iso] of MID) { assert.ok(mid >= 201 && mid <= 775); assert.match(iso, /^[A-Z]{2}$/); }
  });
});

// ------------------------------------------------------------------------------------------------ ports
describe('ports and destinations', () => {
  test('built-in table: ≥ 300 major ports, unique well-formed LOCODEs, sane positions', () => {
    const b = builtinPorts();
    assert.ok(b.length >= 300, `ports: ${b.length}`);
    const seen = new Set();
    for (const p of b) {
      assert.match(p.locode, /^[A-Z]{2}[A-Z2-9]{3}$/, p.locode);
      assert.ok(!seen.has(p.locode), `duplicate ${p.locode}`); seen.add(p.locode);
      assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && p.r > 0, p.locode);
    }
    // every game harbour is reachable by name
    for (const h of HARBORS) assert.ok(ports.resolveDestination(h.name.split(/[/(]/)[0]), `harbour ${h.id} by name`);
  });
  test('LOCODE forms', () => {
    for (const d of ['NLRTM', 'NL RTM', 'NL-RTM', 'NLRTM ANCH', 'nlrtm']) {
      const r = ports.resolveDestination(d);
      assert.equal(r && r.id, 'rotterdam', d); assert.equal(r.locode, 'NLRTM');
    }
    const ska = ports.resolveDestination('DK SKA');
    assert.equal(ska.id, 'DKSKA'); assert.equal(ska.locode, 'DKSKA'); assert.equal(ska.name, 'Skagen'); close(ska.lat, 57.72, 0.05);
    assert.equal(ports.resolveDestination('NLRTM>DEHAM').id, 'hamburg');      // route: the last leg is the destination
    assert.equal(ports.resolveDestination('DE HAM -> NL RTM').id, 'rotterdam');
    const unknown = ports.resolveDestination('SE XQZ');                        // well-formed, not in the table
    assert.equal(unknown.id, 'SEXQZ'); assert.equal(unknown.lat, null);
  });
  test('names, abbreviations and typos', () => {
    assert.equal(ports.resolveDestination('ROTTERDAM').id, 'rotterdam');
    assert.equal(ports.resolveDestination('R DAM').id, 'rotterdam');
    assert.equal(ports.resolveDestination("R'DAM").id, 'rotterdam');
    assert.equal(ports.resolveDestination('HAMBURG/GERMANY').id, 'hamburg');
    assert.equal(ports.resolveDestination('GOTHENBORG').id, 'gothenburg');   // typo
    assert.equal(ports.resolveDestination('ANTWERPEN').id, 'antwerp');
    assert.equal(ports.resolveDestination('SKAGEN').id, 'DKSKA');
    assert.equal(ports.resolveDestination('AMSTERDAM').locode, 'NLAMS');
    assert.equal(ports.resolveDestination('Göteborg').id, 'gothenburg');
    assert.equal(normalizeText("R'DAM@@@"), 'RDAM');
  });
  test('fixes from live destinations (2026-10-08): compound names, routes, shuttles, VIA, UK, truncation, homonyms', () => {
    const R = (d, lat, lon) => { const r = ports.resolveDestination(d, lat, lon); return r && r.locode; };
    assert.equal(R('BERGEN OP ZOOM'), 'NLBZM');                    // was Bergen (NO) by its first word
    assert.equal(R('GOOLE'), 'GBGOO');                             // was Poole by one typo
    assert.equal(R('LA SEINE A ROUEN JEA'), 'FRURO');              // was Los Angeles via the 'LA' prefix
    assert.equal(R('LINDEN'), null);                               // no single-letter substitutions in short names
    assert.equal(R('ROSTOK'), 'DERSK'); assert.equal(R('GOTEBORGG'), 'SEGOT');
    assert.equal(R('NLRTM > NOTAE'), 'NOTAE');                     // a route's destination is its last leg …
    assert.equal(R('NLRTM > SEXQZ'), 'SEXQZ');                     // … even when we only know its LOCODE
    assert.equal(R('GBPME<>GBFBU'), 'GBPME');                      // a shuttle: the first end
    assert.equal(R('DEBRV VIA NOK'), 'DEBRV'); assert.equal(R('US NEW VIA SKAW'), 'USNEW');
    assert.equal(R('NLRTM>>UKFXT'), 'GBFXT');                      // 'UK' for GB
    assert.equal(R('NL RTM2602'), 'NLRTM'); assert.equal(R('NLAMS01090DOCKX00018'), 'NLAMS'); // ERI terminal codes
    assert.equal(R('EUROTANK ETT ROTTERD'), 'NLRTM');              // cut off at 20 characters
    assert.equal(R('EEVAN-FIHEL'), 'EETLL'); assert.equal(R('XXVAN-FIHEL'), 'FIHEL'); // LOCODEs as words
    assert.equal(R('GBTEES .'), 'GBTEE'); assert.equal(R('DK-VEJLE'), 'DKVEJ'); assert.equal(R('GB HARTLEPOOL'), 'GBHTP');
    assert.equal(R('WAALHAVEN ZUID'), 'NLRTM'); assert.equal(R('HAFEN SCHWELGERN'), 'DEDUI'); assert.equal(R('KALLO'), 'BEANR');
    for (const d of ['STADE', 'VENLO', 'COWES', 'RODBY', 'VEERE']) assert.ok(ports.resolveDestination(d).lat != null, `${d} is a place, not a LOCODE`);
    assert.equal(R('EGYPT'), null); assert.equal(R('ALGERIA'), null); assert.equal(R('HARBOUR TUG CH12'), null); assert.equal(R('TO ORDER'), null);
    // homonyms: the vessel's position picks the port, for the name that matched only
    assert.equal(R('PORTLAND', 50.5, -2.4), 'GBPTL'); assert.equal(R('PORTLAND'), 'USPDX');
    assert.equal(R('WILLEMSTAD VOLKERAK', 51.69, 4.43), 'NLWIS'); assert.equal(R('WILLEMSTAD', 12.1, -68.9), 'CWWIL');
    assert.equal(R('CURACAO', 51.69, 4.43), 'CWWIL');
    assert.equal(R('NEWCASTLE', -33, 151), 'AUNTL'); assert.equal(R('NEWCASTLE', 55, -1.5), 'GBNCL');
    // LOCODEs corrected against the UN/LOCODE list
    assert.equal(ports.resolveDestination('GBHLY').name, 'Holyhead'); assert.equal(ports.resolveDestination('RU VYS').name, 'Vysotsk');
    assert.equal(ports.resolveDestination('SEVAG').name, 'Varberg');
  });
  test('non-destinations → null', () => {
    for (const d of ['FOR ORDERS', 'for orders', 'FISHING', '@@@@@@@@', '', null, 'TBA', 'ATLANTIC OCEAN']) assert.equal(ports.resolveDestination(d), null, String(d));
  });
  test('nearestPort uses the in-port radius', () => {
    assert.equal(ports.nearestPort(51.955, 4.06).id, 'rotterdam');
    assert.equal(ports.nearestPort(54.5, 3.0), null);                 // open North Sea
    assert.equal(ports.nearestPort(57.722, 10.6).locode, 'DKSKA');
  });
});

// ------------------------------------------------------------------------------------------------ classes
describe('AIS ship type → class', () => {
  const cases = [
    [{ aisType: 70, length: 90 }, 'coaster'], [{ aisType: 74, length: 150 }, 'feeder'], [{ aisType: 79, length: 290 }, 'boxship'],
    [{ aisType: 70, length: 190, name: 'PACIFIC BULKER' }, 'bulker'], [{ aisType: 70, length: 229, name: 'CAPE ORCHID' }, 'bulker'],
    [{ aisType: 80, length: 180 }, 'tanker'], [{ aisType: 89 }, 'tanker'],
    [{ aisType: 60, length: 185 }, 'ferry'], [{ aisType: 69, length: 15 }, 'cruiser'], [{ aisType: 60, length: 45 }, 'ferry'], [{ aisType: 69, length: 23 }, 'ferry'],
    [{ aisType: 30, length: 40 }, 'trawler'], [{ aisType: 31 }, 'tug'], [{ aisType: 32 }, 'tug'], [{ aisType: 52, length: 30 }, 'tug'],
    [{ aisType: 50, length: 18 }, 'pilot'], [{ aisType: 33, length: 80 }, 'psv'],
    [{ aisType: 36, length: 11 }, 'sloop'], [{ aisType: 36, length: 18 }, 'ketch'], [{ aisType: 36, length: 40 }, 'schooner'],
    [{ aisType: 36, length: 13, beam: 7 }, 'catamaran'],
    [{ aisType: 37, length: 12 }, 'cruiser'], [{ aisType: 37, length: 25 }, 'myacht'], [{ aisType: 37, length: 60 }, 'superyacht'],
    [{ aisType: 35, length: 90 }, 'psv'], [{ aisType: 51, length: 20 }, 'pilot'], [{ aisType: 55, length: 40 }, 'psv'], [{ aisType: 55 }, 'pilot'],
    [{ aisType: 0 }, 'coaster'], [{ aisType: 0, classB: true }, 'cruiser'], [{ aisType: 90, length: 12 }, 'cruiser'],
    [{ aisType: 0, length: 140 }, 'feeder'], [{ aisType: 0, length: 300 }, 'boxship'], [{ aisType: 45, length: 70 }, 'ferry'],
  ];
  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} → ${want}`, () => {
      const cls = classFor(input);
      assert.equal(cls, want);
      assert.ok(SHIP_CLASSES[cls], `${cls} must be a SHIP_CLASSES id`);
    });
  }
});

// ------------------------------------------------------------------------------------------------ parsing
describe('AISStream messages', () => {
  test('PositionReport', () => {
    const [r] = parseAisStreamMessage(fx('aisstream-position-report.json'), NOW);
    assert.equal(r.kind, 'pos'); assert.equal(r.mmsi, 244670587);
    assert.equal(r.lat, 52.1012); assert.equal(r.lon, 3.9123); assert.equal(r.sog, 13.4); assert.equal(r.cog, 47.3); assert.equal(r.heading, 49);
    close(r.rot, -0.7, 0.05); assert.equal(r.nav, 0); assert.equal(r.name, 'NOORDZEE TRADER');
    assert.equal(r.t, Date.UTC(2026, 9, 7, 11, 59, 30, 512)); assert.equal(r.src, 'aisstream');
  });
  test('ShipStaticData', () => {
    const [s] = parseAisStreamMessage(JSON.stringify(fx('aisstream-ship-static.json')), NOW); // as text, like the socket delivers it
    assert.equal(s.kind, 'static'); assert.equal(s.name, 'NOORDZEE TRADER'); assert.equal(s.callsign, 'PDZX'); assert.equal(s.imo, 9456789);
    assert.equal(s.aisType, 70); assert.deepEqual([s.A, s.B, s.C, s.D], [112, 22, 12, 10]); assert.equal(s.draught, 7.8);
    assert.equal(s.destination, 'DEHAM'); assert.equal(s.eta, Date.UTC(2026, 9, 8, 14, 30));
  });
  test('StandardClassBPositionReport', () => {
    const [r] = parseAisStreamMessage(Buffer.from(JSON.stringify(fx('aisstream-classb-position.json'))), NOW);
    assert.equal(r.kind, 'pos'); assert.equal(r.classB, true); assert.equal(r.nav, null); assert.equal(r.heading, 511); assert.equal(r.sog, 5.2);
  });
  test('ExtendedClassBPositionReport carries position and static data', () => {
    const recs = parseAisStreamMessage(fx('aisstream-extended-classb.json'), NOW);
    assert.deepEqual(recs.map((r) => r.kind), ['pos', 'static']);
    assert.equal(recs[1].name, 'SEESTERN'); assert.equal(recs[1].aisType, 36); assert.equal(recs[1].A + recs[1].B, 12);
  });
  test('StaticDataReport parts A and B merge', () => {
    const store = mkStore();
    for (const m of [fx('aisstream-classb-position.json'), ...fx('aisstream-static-data-report.json')]) {
      for (const r of parseAisStreamMessage(m, NOW)) r.kind === 'pos' ? store.upsertPosition(r.mmsi, r, NOW) : store.upsertStatic(r.mmsi, r, NOW);
    }
    const v = store.get(244012345, NOW);
    assert.equal(v.name, 'BLAUWE REIGER'); assert.equal(v.static.callsign, 'PB1234'); assert.equal(v.aisType, 37);
    assert.equal(v.length, 12); assert.equal(v.beam, 4); assert.equal(v.cls, 'cruiser'); assert.equal(v.flag, 'NL');
    assert.equal(v.hdg, 300.2); // heading 511 → COG
  });
  test('server error message', () => {
    assert.deepEqual(parseAisStreamMessage(fx('aisstream-error.json')), [{ kind: 'error', error: 'Api Key Is Not Valid' }]);
    assert.deepEqual(parseAisStreamMessage('not json'), []);
    assert.deepEqual(parseAisStreamMessage({ MessageType: 'PositionReport', Message: { PositionReport: { Valid: false, UserID: 1 } } }), []);
  });
  test('full vessel from position + static: class, size, destination, ETA', () => {
    const store = mkStore();
    for (const name of ['aisstream-ship-static.json', 'aisstream-position-report.json']) {
      for (const r of parseAisStreamMessage(fx(name), NOW)) r.kind === 'pos' ? store.upsertPosition(r.mmsi, r, NOW) : store.upsertStatic(r.mmsi, r, NOW);
    }
    const v = store.get(244670587, NOW);
    assert.equal(v.id, 'ais244670587'); assert.equal(v.cls, 'feeder'); assert.equal(v.length, 134); assert.equal(v.beam, 22); assert.equal(v.draught, 7.8);
    assert.equal(v.dest, 'hamburg'); assert.equal(v.destName, 'Hamburg'); assert.equal(v.destRaw, 'DEHAM');
    assert.equal(v.eta, Date.UTC(2026, 9, 8, 14, 30) / 1000); assert.equal(v.etaText, '08 Oct 14:30 UTC');
    assert.equal(v.flag, 'NL'); assert.equal(v.nav, 'under way using engine'); assert.equal(v.src, 'aisstream');
    assert.deepEqual(v.off, [45, -1]); // hull centre 45 m ahead of / 1 m to port of the antenna
    assert.equal(v.state, 'underway'); assert.equal(v.spd, 13.4);
  });
});

describe('AISStream: real frames (verbatim captures)', () => {
  const live = fx('aisstream-live.json');
  test('PositionReport of 2026-10-07: heading 511 and ROT -128 are "not available"', () => {
    const recs = parseAisStreamMessage(Buffer.from(JSON.stringify(live.position)), NOW); // binary frame, as AISStream sends it
    assert.equal(recs.length, 1);
    const [r] = recs;
    assert.equal(r.kind, 'pos'); assert.equal(r.mmsi, 211307810); assert.equal(r.name, 'BRUECKENKIEKER');
    assert.equal(r.lat, 53.546075); assert.equal(r.lon, 9.983783333333333);
    assert.equal(r.sog, 0); assert.equal(r.cog, 0); assert.equal(r.heading, 511); assert.equal(r.rot, null); assert.equal(r.nav, 0);
    assert.equal(r.t, Date.UTC(2026, 9, 7, 19, 48, 36, 381)); // nanosecond time_utc
    assert.equal(r.classB, false); assert.equal(r.src, 'aisstream');
    const s = mkStore(r.t + 1000);
    assert.equal(s.upsertPosition(r.mmsi, r, r.t + 1000), true);
    const v = s.get(r.mmsi, r.t + 1000);
    assert.equal(v.raw.heading, null); assert.equal(v.hdg, 0); assert.equal(v.rot, null); assert.equal(v.flag, 'DE');
    assert.equal(v.state, 'stopped'); assert.equal(v.lat, 53.546075); assert.equal(v.name, 'BRUECKENKIEKER');
  });
  test('ShipStaticData of 2026-10-07: dimensions, draught in metres, ETA year, IMO 0, destination', () => {
    const t = Date.UTC(2026, 9, 7, 19, 48, 36, 482);
    const [r] = parseAisStreamMessage(JSON.stringify(live.static), t);
    assert.equal(r.kind, 'static'); assert.equal(r.mmsi, 257169000); assert.equal(r.name, 'BERNTINE'); assert.equal(r.callsign, 'LIAS');
    assert.equal(r.imo, 0); assert.equal(r.aisType, 69); assert.deepEqual([r.A, r.B, r.C, r.D], [22, 1, 3, 3]); assert.equal(r.draught, 4);
    assert.equal(r.destination, 'TONSBERG'); assert.equal(r.eta, Date.UTC(2026, 7, 29, 17, 39)); // 29 Aug: the past, not next year
    assert.equal(r.t, t);
    const s = mkStore(t);
    s.upsertStatic(r.mmsi, r, t);
    s.upsertPosition(r.mmsi, { lat: live.static.MetaData.latitude, lon: live.static.MetaData.longitude, sog: 9, cog: 10, nav: 0, t }, t);
    const v = s.get(r.mmsi, t);
    assert.equal(v.static.imo, null); assert.equal(v.length, 23); assert.equal(v.beam, 6); assert.equal(v.draught, 4);
    assert.equal(v.cls, 'ferry'); assert.equal(v.flag, 'NO'); assert.equal(v.aisType, 69);
    assert.equal(v.dest, 'NOTON'); assert.equal(v.destName, 'Tonsberg'); assert.equal(v.destRaw, 'TONSBERG');
    assert.deepEqual(v.off, [10.5, 0]);
  });
  test('frames of 2026-10-08: subscription confirmation, padded names, class B, message 24 part A, inland destination', () => {
    const recs = live.frames.map((m) => parseAisStreamMessage(Buffer.from(JSON.stringify(m)), NOW));
    assert.deepEqual(recs[0], []); // SubscriptionConfirmation
    const [pos] = recs[1];
    assert.equal(pos.mmsi, 244700109); assert.equal(pos.name, 'BENTHE'); assert.equal(pos.sog, 8.3); assert.equal(pos.cog, 92.5);
    assert.equal(pos.t, Date.UTC(2026, 9, 8, 5, 55, 15, 93));
    const [st] = recs[2];
    assert.equal(st.name, 'WERE-DI'); assert.equal(st.callsign, 'OT 3348'); assert.equal(st.aisType, 79); assert.equal(st.draught, 2);
    assert.equal(st.destination, 'BRUG STANDDAARBUITEN'); assert.equal(st.eta, Date.UTC(2026, 9, 7, 15, 56));
    const [a] = recs[3];
    assert.equal(a.kind, 'static'); assert.equal(a.name, 'MRS BOJANGLES'); assert.equal(a.aisType, undefined); assert.equal(a.A, undefined);
    const [b] = recs[4];
    assert.equal(b.kind, 'pos'); assert.equal(b.classB, true); assert.equal(b.sog, 0.2); assert.equal(b.heading, 511); assert.equal(b.name, 'CARINO');
    const t = Date.UTC(2026, 9, 8, 5, 55, 16);
    const s = mkStore(t);
    for (const r of recs.flat()) r.kind === 'pos' ? s.upsertPosition(r.mmsi, r, t) : s.upsertStatic(r.mmsi, r, t);
    s.upsertPosition(205334890, { lat: 51.61143, lon: 4.52388, sog: 6, cog: 80, nav: 0, t }, t);
    const w = s.get(205334890, t);
    assert.equal(w.name, 'WERE-DI'); assert.equal(w.length, 81); assert.equal(w.beam, 10); assert.equal(w.cls, 'coaster'); assert.equal(w.flag, 'BE');
    assert.equal(w.dest, null); assert.equal(w.destRaw, 'BRUG STANDDAARBUITEN'); // a bridge, not a port
    const c = s.get(244020045, t);
    assert.equal(c.cls, 'cruiser'); assert.equal(c.nav, 'class B'); assert.equal(c.hdg, 294); // heading 511 → COG
    assert.equal(s.get(244700109, t).name, 'BENTHE');
  });
});

describe('Digitraffic', () => {
  test('locations and vessels, including the real AGIA DIMITRA sample', () => {
    const store = mkStore();
    const locs = parseLocations(fx('digitraffic-locations.json'), NOW);
    const ves = parseVessels(fx('digitraffic-vessels.json'), NOW);
    assert.equal(locs.length, 5); assert.equal(ves.length, 5);
    for (const r of ves) store.upsertStatic(r.mmsi, r, NOW);
    const accepted = locs.filter((r) => store.upsertPosition(r.mmsi, r, NOW)).length;
    assert.equal(accepted, 4); // lat 91 / lon 181 is "not available"
    const a = store.get(538012359, NOW);
    assert.equal(a.name, 'AGIA DIMITRA'); assert.equal(a.flag, 'MH');
    assert.equal(a.length, 180); assert.equal(a.beam, 30); assert.equal(a.draught, 10.1);
    assert.equal(a.dest, 'DKSKA'); assert.equal(a.destName, 'Skagen'); assert.equal(a.destRaw, 'DK SKA');
    assert.equal(a.eta, Date.UTC(2026, 9, 9, 3, 0) / 1000); // packed 673984 = 9 Oct 03:00 UTC
    assert.equal(a.static.callsign, 'V7B2739'); assert.equal(a.static.imo, 9692789); assert.equal(a.aisType, 70);
    assert.equal(a.sog, 11.6); assert.equal(a.src, 'digitraffic'); assert.equal(a.cls, 'feeder'); // 180 m general cargo
    assert.deepEqual(a.off, [64, -5]);
    const pakri = store.get(276123456, NOW);
    assert.equal(pakri.raw.sog, null); assert.equal(pakri.raw.cog, null); assert.equal(pakri.raw.heading, null); // 102.3 / 360 / 511
    assert.equal(pakri.dest, 'tallinn'); assert.equal(pakri.cls, 'coaster'); // EEMUG (Muuga) is the game's Tallinn harbour since v7
    assert.equal(store.get(230123450, NOW).state, 'moored');
    assert.equal(store.get(230987650, NOW).cls, 'tug');
    assert.equal(store.get(265123456, NOW), null);
    const nordic = store.statics.get(265123456);
    assert.equal(nordic.destination, 'FOR ORDERS'); assert.equal(ports.resolveDestination(nordic.destination), null);
  });
});

// ------------------------------------------------------------------------------------------------ physics
describe('dead reckoning', () => {
  test('12 kn heading 090 for 60 s moves ≈ 370 m east', () => {
    const v = { lat: 54, lon: 3, sog: 12, cog: 90, hdg: 90, rot: 0, nav: 0, t: NOW - 60e3 };
    const p = deadReckon(v, NOW);
    const l = toLocal(p.lat, p.lon, { lat: 54, lon: 3 });
    close(l.x, 12 * 0.514444 * 60, 2, 'east'); close(l.z, 0, 0.5, 'south');
    // through the store / near(): same displacement
    const store = mkStore();
    store.upsertPosition(244000001, { lat: 54, lon: 3, sog: 12, cog: 90, heading: 90, rot: 0, nav: 0, t: NOW - 60e3 }, NOW);
    const [n] = store.near(54, 3, 5000, { now: NOW });
    close(toLocal(n.lat, n.lon, { lat: 54, lon: 3 }).x, 370.4, 2);
  });
  test('extrapolation is capped at 3 min', () => {
    const v = { lat: 54, lon: 3, sog: 12, cog: 0, hdg: 0, rot: 0, nav: 0, t: NOW - 10 * 60e3 };
    const p = deadReckon(v, NOW);
    const l = toLocal(p.lat, p.lon, { lat: 54, lon: 3 });
    close(-l.z, 12 * 0.514444 * 180, 3, 'north');
  });
  test('moored / anchored / stopped vessels never move', () => {
    for (const v of [{ nav: 5, sog: 0.4 }, { nav: 1, sog: 1.2 }, { nav: 0, sog: 0.1 }]) {
      const p = deadReckon({ lat: 54, lon: 3, cog: 90, hdg: 90, rot: 0, t: NOW - 120e3, ...v }, NOW);
      assert.equal(p.lat, 54); assert.equal(p.lon, 3);
    }
  });
  test('rate of turn bends the track for ≤ 60 s, then straight', () => {
    const v = { lat: 54, lon: 3, sog: 10, cog: 0, hdg: 0, rot: 30, nav: 0, t: NOW - 120e3 };
    const p = deadReckon(v, NOW);
    close(p.hdg, 30, 0.01, 'heading after 60 s at 30°/min'); close(p.cog, 30, 0.01);
    const l = toLocal(p.lat, p.lon, { lat: 54, lon: 3 });
    // arc of 60 s (radius = v/ω) then 60 s straight on 030
    const sp = 10 * 0.514444, w = 0.5 * Math.PI / 180, R = sp / w;
    const e = R * (1 - Math.cos(30 * Math.PI / 180)) + sp * 60 * Math.sin(30 * Math.PI / 180);
    const n = R * Math.sin(30 * Math.PI / 180) + sp * 60 * Math.cos(30 * Math.PI / 180);
    close(l.x, e, 2); close(-l.z, n, 2);
  });
});

// ------------------------------------------------------------------------------------------------ store lifecycle
describe('store', () => {
  test('sanity: lat 91 / lon 181, sog 102.3, > 50 kn jumps, out-of-order reports', () => {
    const s = mkStore();
    assert.equal(s.upsertPosition(244000002, { lat: 91, lon: 181, t: NOW }, NOW), false);
    assert.equal(s.upsertPosition(244000002, { lat: 0, lon: 0, t: NOW }, NOW), false);
    assert.equal(s.upsertPosition(244000002, { lat: 53, lon: 3, sog: 102.3, cog: 10, t: NOW - 60e3 }, NOW), true);
    assert.equal(s.get(244000002, NOW).raw.sog, null);
    // 10 km in 30 s = 648 kn → rejected; the old fix stays
    assert.equal(s.upsertPosition(244000002, { lat: 53.09, lon: 3, sog: 10, cog: 0, t: NOW - 30e3 }, NOW), false);
    assert.equal(s.get(244000002, NOW).raw.lat, 53);
    // a second report agreeing with the new place (implied 10 kn from the pending fix) → accepted, track restarts
    assert.equal(s.upsertPosition(244000002, { lat: 53.0915, lon: 3, sog: 10, cog: 0, t: NOW }, NOW), true);
    assert.equal(s.get(244000002, NOW).raw.lat, 53.0915);
    assert.equal(s.get(244000002, NOW).track.length, 1);
    // older than the current report → ignored
    assert.equal(s.upsertPosition(244000002, { lat: 53.05, lon: 3, t: NOW - 20e3 }, NOW), false);
    // invalid MMSIs (AtoN, SART) are not vessels
    assert.equal(s.upsertPosition(992446001, { lat: 52, lon: 4, t: NOW }, NOW), false);
    assert.equal(s.upsertPosition(970123456, { lat: 52, lon: 4, t: NOW }, NOW), false);
  });
  test('track keeps the last 60 points ≥ 30 s apart', () => {
    const s = mkStore();
    for (let i = 0; i < 300; i++) { const t = NOW - (300 - i) * 10e3; s.upsertPosition(244000003, { lat: 53 + i * 1e-4, lon: 3, sog: 1.2, cog: 0, nav: 0, t }, t + 2000); }
    const tr = s.get(244000003, NOW).track;
    assert.equal(tr.length, 60);
    for (let i = 1; i < tr.length; i++) assert.ok(tr[i][2] - tr[i - 1][2] >= 30e3);
    assert.ok(tr.at(-1)[2] >= NOW - 40e3);
  });
  test('stale removal: 20 min underway, 2 h moored; grid stays consistent', () => {
    const s = mkStore();
    const at = (mmsi, p) => assert.equal(s.upsertPosition(mmsi, p, p.t + 1000), true); // each report ingested when it was sent
    at(244000010, { lat: 53, lon: 3, sog: 10, cog: 0, nav: 0, t: NOW - 21 * 60e3 });
    at(244000011, { lat: 53.01, lon: 3, sog: 10, cog: 0, nav: 0, t: NOW - 19 * 60e3 });
    at(244000012, { lat: 53.02, lon: 3, sog: 0, cog: 0, nav: 5, t: NOW - 90 * 60e3 });
    at(244000013, { lat: 53.03, lon: 3, sog: 0, cog: 0, nav: 1, t: NOW - 121 * 60e3 });
    s.upsertStatic(244000099, { name: 'NO POSITION', t: NOW - 25 * 3600e3 }, NOW - 25 * 3600e3);
    assert.equal(s.prune(NOW), 2);
    assert.deepEqual([...s.vessels.keys()].sort(), [244000011, 244000012]);
    assert.deepEqual(s.near(53, 3, 20000, { now: NOW }).map((v) => v.mmsi).sort(), [244000011, 244000012]);
    assert.equal(s.statics.has(244000099), false);
    let inGrid = 0; for (const set of s.grid.values()) inGrid += set.size;
    assert.equal(inGrid, 2);
  });
  test('reports already past the stale limits are not ingested (first Digitraffic poll covers 2 h)', () => {
    const s = mkStore();
    assert.equal(s.upsertPosition(244000020, { lat: 53, lon: 3, sog: 10, cog: 0, nav: 0, t: NOW - 25 * 60e3 }, NOW), false);
    assert.equal(s.upsertPosition(244000021, { lat: 53, lon: 3.1, sog: 0, cog: 0, nav: 5, t: NOW - 25 * 60e3 }, NOW), true); // moored: 2 h
    assert.equal(s.upsertPosition(244000022, { lat: 53, lon: 3.2, sog: 0, cog: 0, nav: 5, t: NOW - 125 * 60e3 }, NOW), false);
    assert.equal(s.counters.stale, 2); assert.equal(s.size, 1);
  });
  test('origin inference: moored in Rotterdam ≥ 10 min, then under way', () => {
    const s = mkStore();
    const id = 244111222;
    s.upsertStatic(id, { name: 'MAAS PIONEER', aisType: 70, A: 100, B: 20, C: 10, D: 8, destination: 'GBHUL', t: NOW - 3600e3 }, NOW - 3600e3);
    // moored at Maasvlakte, a report every 3 min for 30 min
    for (let k = 10; k >= 1; k--) s.upsertPosition(id, { lat: 51.955 + k * 1e-6, lon: 4.06, sog: 0, cog: 0, heading: 270, nav: 5, t: NOW - k * 180e3 - 60e3 }, NOW);
    let v = s.get(id, NOW - 61e3);
    assert.equal(v.from.id, 'rotterdam'); assert.equal(v.from.left, null);
    // casts off and heads out
    s.upsertPosition(id, { lat: 51.9555, lon: 4.058, sog: 3.5, cog: 290, heading: 290, nav: 0, t: NOW - 60e3 }, NOW);
    s.upsertPosition(id, { lat: 51.9567, lon: 4.053, sog: 12, cog: 290, heading: 290, nav: 0, t: NOW }, NOW); // ≈ 370 m in 60 s
    v = s.get(id, NOW);
    assert.equal(v.from.id, 'rotterdam'); assert.equal(v.fromName, 'Rotterdam'); assert.equal(v.from.locode, 'NLRTM');
    assert.equal(v.from.left, NOW - 60e3); assert.equal(v.from.arrived, NOW - 10 * 180e3 - 60e3);
    assert.equal(v.dest, 'hull');
    const pub = s.near(51.9567, 4.053, 1000, { now: NOW })[0];
    assert.equal(pub.from, 'rotterdam'); assert.equal(pub.fromName, 'Rotterdam'); assert.equal(pub.dest, 'hull');
  });
  test('no origin from a short stop or an offshore anchorage', () => {
    const s = mkStore();
    for (let k = 3; k >= 1; k--) s.upsertPosition(244111223, { lat: 51.955, lon: 4.06, sog: 0, cog: 0, nav: 0, t: NOW - k * 120e3 }, NOW); // stopped 4 min
    s.upsertPosition(244111223, { lat: 51.957, lon: 4.052, sog: 10, cog: 290, nav: 0, t: NOW }, NOW);
    assert.equal(s.get(244111223, NOW).from, null);
    for (let k = 8; k >= 1; k--) s.upsertPosition(244111224, { lat: 52.3, lon: 3.3, sog: 0.2, cog: 0, nav: 1, t: NOW - k * 180e3 }, NOW); // North Sea anchorage
    assert.equal(s.get(244111224, NOW).from, null);
  });
  test('a vessel reporting "moored" in port has that port as origin at once; shifting berth keeps it', () => {
    const s = mkStore();
    const id = 244111225;
    s.upsertPosition(id, { lat: 51.955, lon: 4.06, sog: 0, cog: 0, heading: 90, nav: 5, t: NOW - 300e3 }, NOW - 300e3);
    let v = s.get(id, NOW - 300e3);
    assert.equal(v.from.id, 'rotterdam'); assert.equal(v.from.arrived, NOW - 300e3); assert.equal(v.from.left, null);
    // moored, but drifting at 1.2 kn (status not updated): not lying in port by itself
    s.upsertPosition(244111226, { lat: 51.955, lon: 4.07, sog: 1.2, cog: 0, nav: 5, t: NOW - 300e3 }, NOW - 300e3);
    assert.equal(s.get(244111226, NOW).from, null);
    // shifts berth 2 km within the port, moors again: same origin, original arrival time kept
    s.upsertPosition(id, { lat: 51.96, lon: 4.075, sog: 4, cog: 60, nav: 0, t: NOW - 240e3 }, NOW - 240e3);
    assert.equal(s.get(id, NOW - 240e3).from.left, NOW - 240e3);
    s.upsertPosition(id, { lat: 51.962, lon: 4.08, sog: 0, cog: 0, nav: 5, t: NOW - 60e3 }, NOW - 60e3);
    v = s.get(id, NOW);
    assert.equal(v.from.id, 'rotterdam'); assert.equal(v.from.left, null); assert.equal(v.from.arrived, NOW - 300e3);
    // moored out at sea (wrong status, 0 kn): no port, no origin
    s.upsertPosition(244111227, { lat: 54.5, lon: 3, sog: 0, cog: 0, nav: 5, t: NOW }, NOW);
    assert.equal(s.get(244111227, NOW).from, null);
  });
});

// ------------------------------------------------------------------------------------------------ queries
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

describe('near() / bbox()', () => {
  test('near() matches brute force (dead-reckoned) and is sorted', () => {
    const s = mkStore(); const r = rng(7);
    for (let i = 0; i < 3000; i++) {
      s.upsertPosition(244200000 + i, { lat: 53 + r() * 2, lon: 2 + r() * 4, sog: r() < 0.3 ? 0 : r() * 20, cog: r() * 360, nav: r() < 0.2 ? 5 : 0, rot: 0, t: NOW - r() * 300e3 }, NOW);
    }
    for (const [lat, lon, R] of [[54, 4, 40000], [53.2, 2.1, 15000], [54.9, 5.9, 60000]]) {
      const got = s.near(lat, lon, R, { now: NOW, limit: 100000 });
      const want = [];
      for (const v of s.vessels.values()) { const p = deadReckon(v, NOW); if (haversineM(lat, lon, p.lat, p.lon) <= R) want.push(v.mmsi); }
      assert.deepEqual(got.map((v) => v.mmsi).sort(), want.sort(), `near ${lat},${lon},${R}`);
      for (let i = 1; i < got.length; i++) assert.ok(haversineM(lat, lon, got[i - 1].lat, got[i - 1].lon) <= haversineM(lat, lon, got[i].lat, got[i].lon) + 1);
      assert.ok(got.length > 10);
    }
    assert.equal(s.near(54, 4, 40000, { now: NOW, limit: 5 }).length, 5);
  });
  test('near() across the antimeridian', () => {
    const s = mkStore();
    s.upsertPosition(512000001, { lat: -40, lon: 179.95, sog: 0, cog: 0, nav: 0, t: NOW }, NOW);
    s.upsertPosition(512000002, { lat: -40, lon: -179.95, sog: 0, cog: 0, nav: 0, t: NOW }, NOW);
    assert.equal(s.near(-40, 180, 10000, { now: NOW }).length, 2);
  });
  test('bbox() matches brute force; decimates evenly over the limit', () => {
    const s = mkStore(); const r = rng(11);
    for (let i = 0; i < 5000; i++) s.upsertPosition(244300000 + i, { lat: 50 + r() * 8, lon: -2 + r() * 12, sog: 0, cog: 0, nav: 5, t: NOW }, NOW);
    const box = [52, 1, 55, 6];
    const got = s.bbox(...box, { now: NOW });
    const want = [...s.vessels.values()].filter((v) => v.lat >= 52 && v.lat <= 55 && v.lon >= 1 && v.lon <= 6).map((v) => v.mmsi);
    assert.deepEqual(got.map((v) => v.mmsi).sort(), want.sort());
    const dec = s.bbox(50, -2, 58, 10, { now: NOW, limit: 200 });
    assert.ok(dec.length <= 200 && dec.length >= 100, `decimated to ${dec.length}`);
    // spread: every 2°×3° block of the area keeps some vessels
    for (let la = 50; la < 58; la += 2) for (let lo = -2; lo < 10; lo += 3) {
      assert.ok(dec.some((v) => v.lat >= la && v.lat < la + 2 && v.lon >= lo && v.lon < lo + 3), `block ${la},${lo}`);
    }
    // whole world and antimeridian-crossing boxes work
    assert.equal(s.bbox(-90, -180, 90, 180, { now: NOW, limit: 100000 }).length, 5000);
    assert.equal(s.bbox(50, 170, 58, -170, { now: NOW }).length, 0);
  });
  test('speed: 50 000 vessels, near() < 5 ms', () => {
    const s = mkStore(); const r = rng(3);
    for (let i = 0; i < 50000; i++) {
      s.upsertPosition(244000000 + i, { lat: 48 + r() * 14.5, lon: -8 + r() * 22, sog: r() * 20, cog: r() * 360, rot: r() < 0.1 ? 5 : 0, nav: 0, t: NOW - r() * 120e3 }, NOW);
    }
    assert.equal(s.size, 50000);
    for (let i = 0; i < 5; i++) s.near(54, 4, 40000, { now: NOW }); // warm up
    // wall-clock timing on a shared machine: best of three batch medians (and best of three bbox runs)
    let count = 0, median = Infinity;
    for (let batch = 0; batch < 3; batch++) {
      const times = [];
      for (let i = 0; i < 25; i++) {
        const t0 = process.hrtime.bigint();
        count = s.near(52 + (i % 5), 1 + (i % 7), 40000, { now: NOW }).length;
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      times.sort((a, b) => a - b);
      median = Math.min(median, times[Math.floor(times.length / 2)]);
    }
    assert.ok(count > 0);
    assert.ok(median < 5, `near() median ${median.toFixed(2)} ms`);
    let b = null, bms = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = process.hrtime.bigint();
      b = s.bbox(48, -8, 62.5, 14, { now: NOW });
      bms = Math.min(bms, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    assert.ok(b.length <= 2000 && b.length > 500, `bbox decimated to ${b.length}`);
    assert.ok(bms < 250, `bbox() ${bms.toFixed(1)} ms`);
  });
});

// ------------------------------------------------------------------------------------------------ sources
describe('AISStream source', () => {
  test('no key → disabled with one log line, no socket', () => {
    const logs = []; const WS = fakeWsClass();
    const src = new AisStreamSource({ store: mkStore(), log: (...a) => logs.push(a.join(' ')), WebSocketImpl: WS, env: {}, keyFile: '/nonexistent/aisstream.key', offline: false });
    src.start();
    assert.equal(src.enabled, false); assert.equal(WS.instances.length, 0);
    assert.equal(logs.length, 1); assert.match(logs[0], /disabled: no API key/);
    assert.equal(readApiKey({ env: { AISSTREAM_API_KEY: '  abc \n' } }), 'abc');
  });
  test('subscribes on open, ingests messages, reconnects with backoff 5 s → 5 min, resets after data', async () => {
    const clock = fakeClock(); const WS = fakeWsClass(); const store = mkStore();
    store.now = clock.now;
    const logs = [];
    const src = new AisStreamSource({ store, log: (...a) => logs.push(a.join(' ')), WebSocketImpl: WS, apiKey: 'KEY', now: clock.now, timers: clock.timers, offline: false, global: false });
    src.start();
    assert.equal(WS.instances.length, 1);
    const ws = WS.instances[0];
    assert.equal(ws.url, 'wss://stream.aisstream.io/v0/stream');
    ws.open();
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(ws.sent[0], { APIKey: 'KEY', BoundingBoxes: [[[48, -8], [62.5, 14]]], FilterMessageTypes: MESSAGE_TYPES });
    ws.msg(fx('aisstream-ship-static.json')); ws.msg(fx('aisstream-position-report.json'));
    assert.equal(src.stats().msgs, 2); assert.equal(store.size, 1); assert.equal(store.get(244670587).cls, 'feeder');
    ws.msg(fx('aisstream-error.json'));
    assert.equal(src.stats().lastError, 'Api Key Is Not Valid');
    assert.ok(logs.some((l) => /Api Key Is Not Valid/.test(l)));
    assert.ok(!JSON.stringify(src.stats()).includes('KEY'), 'the key never appears in stats');
    // connection drops: 5, 10, 20, 40, 80, 160, 300, 300 s
    const delays = [];
    for (let i = 0; i < 8; i++) {
      const before = WS.instances.length;
      WS.instances.at(-1).fail();
      const t0 = clock.now();
      // step in 1 s increments until the next socket appears
      while (WS.instances.length === before) { await clock.advance(1000); if (clock.now() - t0 > 400e3) break; }
      delays.push((clock.now() - t0) / 1000);
    }
    assert.deepEqual(delays, [5, 10, 20, 40, 80, 160, 300, 300]);
    // a healthy connection resets the backoff
    const ws2 = WS.instances.at(-1); ws2.open(); ws2.msg(fx('aisstream-position-report.json'));
    assert.equal(ws2.sent.length, 1, 'resubscribed on the new connection');
    const before = WS.instances.length; ws2.fail();
    await clock.advance(5000);
    assert.equal(WS.instances.length, before + 1);
    src.stop();
    assert.equal(clock.pending().length, 0, 'stop() clears every timer');
  });
  test('idle watchdog reconnects a silent connection', async () => {
    const clock = fakeClock(); const WS = fakeWsClass();
    const src = new AisStreamSource({ store: mkStore(), WebSocketImpl: WS, apiKey: 'K', now: clock.now, timers: clock.timers, idleMs: 120e3, offline: false });
    src.start(); WS.instances[0].open();
    await clock.advance(150e3);
    assert.ok(WS.instances[0].closed || WS.instances.length > 1);
    await clock.advance(10e3);
    assert.equal(WS.instances.length, 2);
    src.stop();
  });
  test('interest boxes: players outside the detail region, resubscribe at most every 60 s, ≤ 10 boxes', async () => {
    const clock = fakeClock(); const WS = fakeWsClass();
    const src = new AisStreamSource({ store: mkStore(), WebSocketImpl: WS, apiKey: 'K', now: clock.now, timers: clock.timers, offline: false, global: false });
    src.start(); const ws = WS.instances[0]; ws.open();
    assert.equal(ws.sent.length, 1);
    await clock.advance(10e3);
    src.setInterest([{ lat: 54, lon: 4 }, { lat: 40.6, lon: -74 }]); // one inside the region, one in New York
    assert.equal(ws.sent.length, 1, 'not before 60 s');
    await clock.advance(50e3);
    assert.equal(ws.sent.length, 2);
    const boxes = ws.sent[1].BoundingBoxes;
    assert.equal(boxes.length, 2);
    assert.deepEqual(boxes[0], [[48, -8], [62.5, 14]]);
    const [[la0, lo0], [la1, lo1]] = boxes[1];
    assert.ok(la0 < 40.6 && la1 > 40.6 && lo0 < -74 && lo1 > -74); close(la1 - la0, 1.5, 1e-9, 'box height');
    src.setInterest([{ lat: 40.6, lon: -74 }]); // same boxes → nothing
    await clock.advance(120e3);
    assert.equal(ws.sent.length, 2);
    // 20 players scattered around the world → capped
    const pts = Array.from({ length: 20 }, (_, i) => ({ lat: -60 + i * 6, lon: -170 + i * 17 }));
    src.setInterest(pts);
    await clock.advance(1);
    assert.equal(ws.sent.length, 3);
    assert.ok(ws.sent[2].BoundingBoxes.length <= 10);
    for (const p of pts) assert.ok(ws.sent[2].BoundingBoxes.some(([[a, b], [c, d]]) => p.lat >= a && p.lat <= c && p.lon >= b && p.lon <= d), `covers ${p.lat},${p.lon}`);
    src.stop();
  });
  test('boxesFor merges overlaps and splits at the antimeridian', () => {
    assert.deepEqual(boxesFor([]), [[[48, -8], [62.5, 14]]]);
    assert.equal(boxesFor([{ lat: 40, lon: -70 }, { lat: 40.5, lon: -69.5 }]).length, 2);  // two overlapping boxes → one
    const am = boxesFor([{ lat: -40, lon: 179.8 }], { detail: null });
    assert.equal(am.length, 2);
    assert.ok(am.every(([[, a], [, b]]) => a >= -180 && b <= 180));
    assert.deepEqual(DETAIL_BOX, { latMin: 48, lonMin: -8, latMax: 62.5, lonMax: 14 });
  });
});

describe('Digitraffic source', () => {
  test('polls locations every 20 s with from = last poll − 5 s, vessels every 30 min, headers, backoff on failure', async () => {
    const clock = fakeClock(); const store = mkStore(); store.now = clock.now;
    let fail = 0;
    const fetchImpl = fakeFetch([
      [/\/locations\?from=\d+$/, () => (fail-- > 0 ? new Error('ECONNRESET') : { body: fx('digitraffic-locations.json') })],
      [/\/vessels\?from=\d+$/, () => ({ body: fx('digitraffic-vessels.json') })],
    ]);
    const src = new DigitrafficSource({ store, fetchImpl, now: clock.now, timers: clock.timers, offline: false });
    src.start();
    await clock.advance(0);
    const locCalls = () => fetchImpl.calls.filter((c) => c.url.includes('/locations'));
    assert.equal(locCalls().length, 1);
    const vesCalls = () => fetchImpl.calls.filter((c) => c.url.includes('/vessels'));
    assert.equal(vesCalls().length, 1);
    assert.equal(vesCalls()[0].url, `https://meri.digitraffic.fi/api/ais/v1/vessels?from=${NOW - 365 * 86400e3}`);
    const first = locCalls()[0];
    assert.equal(first.url, `https://meri.digitraffic.fi/api/ais/v1/locations?from=${NOW - 2 * 3600e3}`);
    assert.equal(first.init.headers['Digitraffic-User'], 'Saltline/0.5');
    assert.equal(first.init.headers['Accept-Encoding'], 'gzip');
    assert.equal(store.size, 4);
    assert.equal(store.get(538012359).name, 'AGIA DIMITRA');
    await clock.advance(20e3);
    assert.equal(locCalls().length, 2);
    assert.equal(locCalls()[1].url.split('from=')[1], String(NOW - 5000));
    // two failures: retry after 40 s, then 80 s
    fail = 2;
    await clock.advance(20e3); assert.equal(locCalls().length, 3); assert.equal(src.stats().failures, 1);
    await clock.advance(39e3); assert.equal(locCalls().length, 3);
    await clock.advance(1e3); assert.equal(locCalls().length, 4); assert.equal(src.stats().failures, 2);
    await clock.advance(80e3); assert.equal(locCalls().length, 5); assert.equal(src.stats().failures, 0);
    // from stays anchored to the last SUCCESSFUL poll
    assert.equal(locCalls()[4].url.split('from=')[1], String(NOW + 20e3 - 5000));
    await clock.advance(30 * 60e3);
    assert.equal(vesCalls().length, 2);
    assert.equal(vesCalls()[1].url.split('from=')[1], String(NOW - 60e3), 'later metadata polls ask only for changes');
    const st = src.stats();
    assert.equal(st.enabled, true); assert.equal(st.connected, true); assert.equal(st.metadata, 5); assert.ok(st.msgs >= 5);
    src.stop();
    assert.equal(clock.pending().length, 0);
  });
});

describe('LiveAis', () => {
  test('SALTLINE_OFFLINE=1 → no network at all, empty table', () => {
    const WS = fakeWsClass(); const fetchImpl = fakeFetch([]); const logs = [];
    const ais = new LiveAis({ log: (...a) => logs.push(a.join(' ')), harbors: HARBORS, fetchImpl, WebSocketImpl: WS, apiKey: 'K', env: { SALTLINE_OFFLINE: '1' } });
    ais.start();
    assert.equal(WS.instances.length, 0); assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(ais.near(54, 4, 40000), []); assert.equal(ais.covers(54, 4), false); assert.equal(ais.get(1), null);
    const st = ais.stats();
    assert.equal(st.vessels, 0); assert.equal(st.sources.aisstream.enabled, false); assert.equal(st.sources.digitraffic.enabled, false);
    assert.equal(logs.length, 1);
    ais.stop();
  });
  test('both sources through one facade: near, bbox, get, covers, stats', async () => {
    const clock = fakeClock(); const WS = fakeWsClass();
    const fetchImpl = fakeFetch([
      [/\/locations/, () => ({ body: fx('digitraffic-locations.json') })],
      [/\/vessels\?from=\d+$/, () => ({ body: fx('digitraffic-vessels.json') })],
    ]);
    const ais = new LiveAis({ harbors: HARBORS, fetchImpl, WebSocketImpl: WS, apiKey: 'K', now: clock.now, timers: clock.timers, offline: false, sources: { aisstream: { global: false } } });
    ais.start();
    await clock.advance(0);
    const ws = WS.instances[0]; ws.open();
    for (const f of ['aisstream-ship-static.json', 'aisstream-position-report.json', 'aisstream-classb-position.json', 'aisstream-extended-classb.json']) ws.msg(fx(f));
    assert.equal(ais.stats().vessels, 7);
    const near = ais.near(52.1, 3.95, 30000);
    assert.equal(near[0].mmsi, 244670587);
    const keys = ['id', 'mmsi', 'name', 'cls', 'aisType', 'flag', 'lat', 'lon', 'sog', 'cog', 'hdg', 'rot', 'nav', 'length', 'beam', 'draught',
      'dest', 'destName', 'destRaw', 'from', 'fromName', 'eta', 't', 'src'];
    for (const k of keys) assert.ok(k in near[0], `AisPublic.${k}`);
    assert.equal(ais.bbox(55, 9, 61, 26).length, 4);   // AGIA DIMITRA in the Kattegat + three around Helsinki
    const g = ais.get('ais538012359');
    assert.equal(g.destName, 'Skagen'); assert.ok(Array.isArray(g.track)); assert.equal(g.static.draught, 10.1); assert.equal(g.to.locode, 'DKSKA');
    assert.equal(ais.covers(60.16, 24.95), true);       // three fresh Digitraffic vessels around Helsinki
    assert.equal(ais.covers(54.5, 3.0), false);
    const st = ais.stats();
    assert.equal(st.sources.aisstream.connected, true); assert.equal(st.sources.digitraffic.connected, true);
    assert.ok(st.coverage.some((c) => c.src === 'aisstream' && c.kind === 'subscribed'));
    assert.ok(st.coverage.some((c) => c.src === 'digitraffic' && c.kind === 'data' && c.vessels === 4));
    // data coverage is split per subscription box: a vessel off New York is its own area, not part of the North Sea box
    ais.store.upsertPosition(366000001, { lat: 40.6, lon: -74.0, sog: 5, cog: 0, nav: 0, t: clock.now(), src: 'aisstream' }, clock.now());
    const cov = ais.stats().coverage.filter((c) => c.src === 'aisstream' && c.kind === 'data');
    assert.equal(cov.length, 2); assert.ok(cov.every((c) => c.lonMax - c.lonMin < 20));
    // ships go stale without new reports: 20 min later (moored 2 h)
    await clock.advance(21 * 60e3 + 30e3);
    ais.sources.digitraffic.stop(); ws.fail(); ais.sources.aisstream.stop();
    ais.store.prune(clock.now() + 60 * 60e3);
    assert.ok(ais.stats().vessels <= 1, 'only the moored ferry may remain');
    ais.stop();
  });
});

test('AISStream subscribes to the whole world by default; AIS_GLOBAL=0 keeps the region + player boxes', () => {
  const store = { upsertPosition() {}, upsertStatic() {} };
  const g = new AisStreamSource({ store, apiKey: 'K', offline: false, env: {} });
  assert.deepEqual(g.wanted, GLOBAL_BOXES);
  g.setInterest([{ lat: 40.6, lon: -74 }]);
  assert.deepEqual(g.wanted, GLOBAL_BOXES, 'player positions do not narrow a worldwide subscription');
  const r = new AisStreamSource({ store, apiKey: 'K', offline: false, env: { AIS_GLOBAL: '0' } });
  assert.notDeepEqual(r.wanted, GLOBAL_BOXES);
  r.setInterest([{ lat: 40.6, lon: -74 }]);
  assert.equal(r.wanted.length, 2, 'detail region + a box off New York');
});
