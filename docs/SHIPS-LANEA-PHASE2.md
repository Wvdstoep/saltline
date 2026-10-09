# Lane A (ships data + yard server), phase 2: the hook edits to existing files

Contract: `docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md` (§7.2 frozen interface, §7.4 hooks H1–H4, H8, H8b, H8c, §8 migration).
Phase 1 added new files only. This page lists every edit to an existing file, each with its anchor (the statement
it sits next to) and code ready to paste. Apply them **after** the files' current owners have merged; re-check each
anchor first.

## What phase 1 delivered (new files only)

| File | Contents |
|---|---|
| `shared/ships/catalogue.js` | `MODELS` (76: 59 new + the 17 legacy ids), `LEGACY_ROWS` (verbatim copy of today's 17 rows), the §2.4 derivation, `SOURCE_ROWS` |
| `shared/ships/optrules.js` | `OPTIONS` table (§2.5), model-level option rules `modelAllows`, `ecoGrade`. No imports |
| `shared/ships/options.js` | `variantId`, `parseVariant`, `defaultOpts`, `priceMul`, `burnMul` |
| `shared/ships/rows.js` | `legacyRows` (the 13 non-sail rows for H1), `classRow(id, base?)` (cached), `priceBasis` |
| `shared/ships/classes.js` | the SHIP_CLASSES wrapper: `installVariants(table)` (H1 one-liner), `classesProxy(rows)` (the contract's form) |
| `shared/ships/yards.js` | `YARD`, `SCHEDULES`, `MILESTONE_AT`, `YARD_COUNTRIES` (23), `YARDS` (60), `localYard(h)`, `BUILD_SHARE`, class societies |
| `shared/ships/index.js` | the frozen interface of §7.2 plus `financing`, `newOrder`, `delayRoll`, `compactOrder`, `noteFlagChange`, `shipValueCompat`, `publicListing`, `inspectionReport`, `healShipsVessel`, `healOrders`, `healHarborYard`, `registerHarbors` |
| `server/yard.js` | `class Yard` (orders, instalments, delays, default, cancel, delivery, stock, used market, inspection, repaint, rename, `onReflag`, `heal`) |
| `scripts/ships/gen-catalogue.mjs` | prints Appendix A; `--check` compares every game column with the contract (59/59 new rows match) |
| `scripts/ships/validate.mjs` | data checks (builders, yards, harbours, countries); `--verify` lists rows still to verify |
| `test/ships-catalogue`, `ships-options`, `ships-yard`, `ships-value`, `yard-server`, `ships-migration` `.test.mjs` | 41 tests with the contract's numbers |

None of the new modules imports `shared/constants.js` except `server/yard.js`, so H1 adds no import cycle:
`constants.js → ships/classes.js → ships/rows.js → ships/{catalogue, options, optrules}.js` (none of them imports
constants).

---

## H1 — `shared/constants.js` · `SHIP_CLASSES`

**Recommended: a one-line hook plus its import.** It keeps the object identity and all 17 literal rows (so H1 does not
touch any row and the sail rows stay as SAILING owns them). Model and variant ids then resolve through the object's
prototype; `Object.keys/values/entries`, `for…in` over own keys, and `JSON.stringify` (the `welcome` payload) still give
exactly the 17 legacy ids.

At the top, after the first comment line `// Shared constants — imported by both the Node server and the browser client (plain ESM, no deps).`:

```js
import { installVariants } from './ships/classes.js';   // SHIPYARD H1 (docs/SHIPS-LANEA-PHASE2.md)
```

Directly after the closing `};` of `export const SHIP_CLASSES = { … schooner: { … }, };` (the line before
`export const GOODS = {`):

```js
installVariants(SHIP_CLASSES);   // SHIPYARD H1: model and variant ids resolve (shared/ships/classes.js); enumeration unchanged
```

Behaviour after the hook (checked on a scratch copy with the real `Game`, `physics.js`, `fleet.js`, `economy.js`):
`Object.keys(SHIP_CLASSES).length === 17`; `'tug24' in SHIP_CLASSES`; `SHIP_CLASSES['ultramax64~lng.i1c.esd'].burn === 1.171`;
`SHIP_CLASSES['ultramax64~lng.meoh'] === undefined`; `SHIP_CLASSES.vlcc300.length === 333`; a delivered
`ultramax64~lng.esd` survives `fleet.healVessel` and `adoptPlayer` (its `!SHIP_CLASSES[v.ship.cls]` guard now passes).

Note: `Object.prototype.hasOwnProperty.call(SHIP_CLASSES, 'tug24')` stays **false** — `server/searoute.js` uses that test
to validate `q.cls` for `/api/route`, so route planning for new models keeps falling back as today until its owner
changes that line to `q.cls in SHIP_CLASSES` (optional, not part of this lane).

**Contract form (alternative, equivalent):** replace the 13 non-sail literal rows by `legacyRows` and wrap in the Proxy:

```js
import { legacyRows } from './ships/rows.js';
import { classesProxy } from './ships/classes.js';
export const SHIP_CLASSES = classesProxy({
  ...legacyRows,
  // --- sailing yachts (SAILING owns these rows; unchanged) ---
  sloop: { … }, ketch: { … }, catamaran: { … }, schooner: { … },
});
```

Use this form only if the reviewer wants the rows moved; `test/ships-catalogue.test.mjs` guarantees `legacyRows` are
byte-identical to today's rows either way. **Wave 2 D12** (`coaster.price = 120000`) then lands in
`shared/ships/catalogue.js` `LEGACY_ROWS.coaster` (and the literal row if the one-liner form is used).

---

## H2 — `server/game.js` · `sendHarbor` (+ the Yard instance)

Import, next to `import { Fleet } from './fleet.js';`:

```js
import { Yard, YARD_ACTIONS } from './yard.js';                 // SHIPYARD (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §4)
```

Constructor, directly after `this.fleet = new Fleet(this);                   // v6 fleet: …`:

```js
    this.yard = new Yard(this);                     // SHIPYARD: orders, stock, second-hand market (before loadState)
```

In `sendHarbor`, directly after the line that starts `used: st.used || [], tradeIn: shipValue(p.ship.cls, p.cond), sellValue:`:

```js
        yard: this.yard.view(p, h),                  // SHIPYARD §7.3: newbuild/stock/used/orders (old shipyard/used kept one release)
```

In `privateState(p)`, add to the returned object (next to `jobs: p.jobs,`):

```js
      orders: (p.office?.orders || []).map((o) => compactOrderView(o, this.simTime)),   // SHIPYARD §7.3 you.orders
```

with `import { compactOrder as compactOrderView } from '../shared/ships/index.js';` next to the Yard import.

## H3 — `server/game.js` · action switch next to `case 'buy_ship':`

Directly after `case 'buy_ship': return this.fleet.buyShip(p, m);   // v6: tradeIn !== false → today's buyShip`:

```js
        case 'yard_order': case 'yard_pay': case 'yard_cancel': case 'yard_deliver': case 'yard_buy_stock':
        case 'yard_inspect': case 'yard_buy_used': case 'yard_repaint': case 'yard_rename':
          this.yard.action(p, m); this.sendYou(p); return this.sendHarbor(p);   // SHIPYARD §7.3 (YARD_ACTIONS)
```

(`Yard.action` rate-limits through `fleet.allow`, validates every field, and books money through `fleet.book`/`charge`.)

If the DOCK ANYWHERE `ACTION_SERVICE` table should gate yard purchases at quays, add the four buying actions there
(owner's decision; not needed for correctness).

## H4 — `server/game.js` · tick

Directly after `this.fleet.tick(dt);                              // v6: drift booking, owed bills, captains, storage, `fleet` pushes`:

```js
    this.yard.tick(this.simTime);                     // SHIPYARD: instalments, milestones, delays, delivery (runs once per sim second)
```

## Harbour state on load — `server/game.js` · `initHarbors`

Directly after `if (!st.stock || !st.target) Object.assign(st, initEconomy(h, this.rnd));`:

```js
      healHarborYard(st);                              // SHIPYARD §8: the new second-hand market regenerates at the first visit
```

with `healHarborYard` added to the `../shared/ships/index.js` import. Note: `healHarborYard` sets `st.usedAt = 0`, so the
legacy `used` list (old clients) is also regenerated at the next `regenHarbor` — exactly the §8 rule.

---

## H8 — `server/fleet.js`

Import, after `import * as captain from './captain.js';`:

```js
import { healShipsVessel, healOrders, marketValue } from '../shared/ships/index.js';   // SHIPYARD H8
import { vesselSlotsUsed } from '../shared/fleet.js';                                  // SHIPYARD H8c
```

(`vesselSlotsUsed` is added to the existing `../shared/fleet.js` import list instead if preferred.)

**`healVessel(v, office)`** — directly before its final `return v;`:

```js
    healShipsVessel(v, sim);                        // SHIPYARD §8: spec + hist (estimated: value unchanged); never touches cls or money
```

**`healOffice(o, rec)`** — directly before `void sim; void rec;`:

```js
    healOrders(out);                                // SHIPYARD §8: office.orders = [] on old saves
```

**`makeVessel(ownerId, f)`** — in the returned object, after `stats: newStats(),`:

```js
      spec: f.spec ?? null, hist: f.hist ?? null,   // SHIPYARD §4.6 (server/yard.js fills both at delivery; healVessel heals null)
```

**Vessel-count checks (open orders count toward `FLEET.MAX_VESSELS`, Q3).** In `buyNew` replace

```js
    if (p.fleet.length >= FLEET.MAX_VESSELS) return this.warn(p, `Your fleet is full (${FLEET.MAX_VESSELS} ships). Sell or trade in a ship first.`);
```

with

```js
    if (vesselSlotsUsed(p) >= FLEET.MAX_VESSELS) return this.warn(p, `Your fleet is full (${FLEET.MAX_VESSELS} ships and orders). Sell or trade in a ship first.`);
```

and in `harborFields` replace `fleetFull: p.fleet.length >= FLEET.MAX_VESSELS,` with
`fleetFull: vesselSlotsUsed(p) >= FLEET.MAX_VESSELS,`.

**`buyNew` new hulls → the yard's stock path.** At the top of `buyNew(p, m, used = false)`, before
`const g = this.game;`:

```js
    if (!used && m && typeof m.stockId === 'string' && this.game.yard) return this.game.yard.action(p, { ...m, action: 'yard_buy_stock' });   // SHIPYARD H8
```

(Legacy `buy_ship { cls, tradeIn: false }` from old clients keeps today's path for one release.)

**`sellAction`** — the Jones premium applies where she is sold. Replace `const value = shipValue(v.ship.cls, v.cond);` with

```js
    const value = v.ship.cls === 'coaster' && !(SHIP_CLASSES.coaster.price > 0) ? 0 : marketValue(v, harborById(v.docked)?.country ?? null, Math.floor(g.simTime));   // SHIPYARD §4.5
```

For every migrated ship this is today's `shipValue` (tested for every legacy id and every condition 0–100); new ships
get age, build country, finish and the US premium. `fleetView` keeps `shipValue` (fleet value at no harbour).

---

## H8b — `server/economy.js`

Import, after `import { JOBTIME, refClassFor, budgetFor } from '../shared/jobtime.js';`:

```js
import { shipValueCompat, modelOf } from '../shared/ships/index.js';   // SHIPYARD H8b
```

**`shipValue`** — replace the body (same numbers for every legacy id and condition; the coaster stays 0 until wave 2
sets its price, then 55,836 at 78 %):

```js
export function shipValue(cls, cond) { return shipValueCompat(cls, cond, SHIP_CLASSES); }
```

**`shipSpecs(cls)`** — replace the `return { … };` line with:

```js
  const m = modelOf(cls);
  return { length: C.length, beam: C.beam, draft: C.draft, maxKn: C.maxKn, capacity: C.capacity, pax: C.pax, fuelCap: C.fuelCap, burn: C.burn, crewCost: C.crewCost, price: C.price, displacement: C.displacement, sail: !!C.sail, towPower: C.towPower || 0,
    ...(m ? { model: m.id, type: m.type, era: m.era, refName: m.refName, dwt: m.dwt, gt: m.gt, depth: m.depth, airDraft: C.airDraft ?? m.airDraft, kW: m.kW, engine: m.engine.label, svcKn: m.svcKn,
      crew: m.crew, usdM: m.usdM, units: m.units, handling: m.handling, eq: m.eq, eco: C.eco ?? m.stats.eco, verify: m.verify } : {}) };   // SHIPYARD §4.7 spec sheet
```

**`generateUsedShips`** — unchanged in this release (it feeds the legacy `used` field for old clients; the new market
is `Yard.listingsAt`). Remove it together with the legacy `shipyard`/`used` fields one release later.

## H8c — `shared/fleet.js`

After `export function homeAllowed(h) { … }`:

```js
/** Ships plus open newbuild orders: both count toward FLEET.MAX_VESSELS (SHIPYARD Q3). */
export function vesselSlotsUsed(p) {
  return (p?.fleet?.length || 0) + (p?.office?.orders || []).filter((o) => o && ['ordered', 'building', 'launched', 'ready'].includes(o.state)).length;
}
```

(`'ships'` is already in `LEDGER_CATS`; no change there.)

---

## `server.js` — anonymous yard quotes for the configurator (optional, read-only)

Import, after `import { Game } from './server/game.js';`:

```js
import { yardsFor, parseVariant } from './shared/ships/index.js';   // SHIPYARD: yard list for one design (no politics: per-player blocks come with harbor.yard)
```

Next to `app.get('/api/jobs', …)`:

```js
app.get('/api/yard/quote', (req, res) => {   // SHIPYARD §4.7: [{ yardId, name, cc, price, hours, specialist, schedule }]
  const variant = String(req.query.variant || '');
  if (!parseVariant(variant)) return res.status(400).json({ error: 'unknown design' });
  res.json(yardsFor(variant, { harbor: typeof req.query.harbor === 'string' ? req.query.harbor.slice(0, 64) : null }));
});
```

`server/yard.js` registers the harbour list itself (`registerHarbors(HARBORS)` in the `Yard` constructor). The client
(Lane B) must call `registerHarbors(welcome.world.harbors)` once from `shared/ships/index.js` before it resolves
`local:<harbour>` yards.

---

## Requests to other owners (not edited by this lane)

| To | Hook | Code |
|---|---|---|
| POLITICS (R1 flag hook) | `server/politics.js` `reflagComplete(p, v)`, after the line that pushes the old flag to `v.flagWas` | `const oldCc = v.flag?.cc;` captured before the push, then after `v.flag = { cc, … }`: `this.game.yard?.onReflag(p, v, oldCc, cc);` |
| POLITICS (R1 rule) | national cabotage check | also require `jonesOk(vessel)` from `shared/ships/index.js` when `cabotage.neverForeign` is set on `US` |
| POLITICS (R3) | `shared/politics.js` | `export function yardCheck(ds, ctx, cc) → { ok, block? }` — `server/yard.js` calls it automatically (via `import * as POLI`) as soon as it exists **and** `game.politics` is set; until then every yard is allowed and no badge shows |
| POLITICS (R2) | Section 301 port fees on Chinese-built ships | status checked 2026-10-09: the USTR fees took effect 14 Oct 2025 and were suspended for one year from 10 Nov 2025; the suspension lapses 9 Nov 2026 unless USTR extends it. Seed `inactive` and re-check before enabling |
| WAVE 2 bank | `game.bank.offerShipLoan(p, { orderId, price, ltv, years, agency, titleXI }) → { ok, loanId, cr }` | `Yard.order` uses it when present (loan credit pays instalments first); cash only without it |
| WAVE 2 shipstats | `MODELS[id].stats` and `effStats(vessel)` | read for non-legacy ids; legacy ids keep their own table |
| Lane B / C (H9–H12) | `baseOf(cls)` for id-keyed tables (`BUILDERS`, `HOUSE`, `MERCHANT_HULL`, `RPM`, AIS `FAMILY`) | `server/traffic.js` (server side of H12) reads `SHIP_CLASSES[s.cls]` only for its own legacy mix — no change needed |

## Known deviations from the contract text (for the reviewer)

1. **Coaster value.** Contract §4.5/§9 says the migrated coaster at 78 % is worth 55,836 "(= today)". Today's
   `shipValue('coaster', 78)` is **0** (`SHIP_CLASSES.coaster.price = 0`); 55,836 uses the wave-2 D12 price 120,000.
   `marketValue` returns 55,836 (catalogue `basis: 120000`, as tested); the H8b `shipValue` wrapper returns today's 0
   until D12 sets the price, then 55,836 automatically. Coasters are orderable at the 120,000 basis (× country).
2. **Size-rule exceptions** in `test/ships-catalogue.test.mjs`: the real 294 × 32.2 m Panamax container class has
   L/B 9.13 (> 9); and Appendix A's own Admiralty coefficients are below 300 for `expedition105` (141), `cruise362`
   (243) and `lngbv7500` (187) — diesel-electric plants whose kW also feeds hotel/cargo load — so they are listed
   exceptions with `hsc112`.
3. **Production holds while an instalment is overdue** (Game rule added): milestones do not advance during the 48 h
   grace; delivery needs every instalment paid.
4. `ultramax64.options` follows the §2.5 table literally (includes `i1as`); the §2.2 example list omitted it.
5. `tshd100` uses range 6,010 nm (instead of a round 6,000) so its fuel capacity matches Appendix A (481 t).
6. `ulcv24k` keeps the contract's 399.9 × 61.5 m; the real 24,346 TEU MSC Irina is 399.99 × 61.3 m (row stays `verify: true`).
