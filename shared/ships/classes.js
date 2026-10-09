// The SHIP_CLASSES lookup wrapper (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §7.2, hook H1). Model and variant ids
// resolve through `classRow`; enumeration (Object.keys/values/entries, JSON) still yields only the table's own rows, so
// every loop over SHIP_CLASSES behaves exactly as today.
//
// Two equivalent ways to install it (docs/SHIPS-LANEA-PHASE2.md H1):
//  * one line after the literal in shared/constants.js:   installVariants(SHIP_CLASSES);
//    (keeps the object identity and every literal row; unknown keys fall through to a prototype that resolves variants)
//  * the contract's Proxy form:                            export const SHIP_CLASSES = classesProxy({ ...legacyRows, sloop, … });
import { classRow } from './rows.js';

const OP = Object.prototype;

/** A Proxy usable as the PROTOTYPE of a plain table: missing string keys resolve to classRow(key, table). */
export function variantProto(table) {
  return new Proxy(Object.create(null), {
    get(_t, k, recv) {
      if (typeof k !== 'string' || k in OP) return Reflect.get(OP, k, recv);
      return classRow(k, table) ?? undefined;
    },
    has(_t, k) { return k in OP || (typeof k === 'string' && !!classRow(k, table)); },
    // assignment of a new key on the table must create an own property, not land on the prototype
    set(_t, k, v, recv) { return Reflect.defineProperty(recv, k, { value: v, writable: true, enumerable: true, configurable: true }); },
    getPrototypeOf() { return OP; },
  });
}

/** Install variant lookup on an existing table in place (returns the same object). Idempotent. */
export function installVariants(table) {
  if (!table || table[INSTALLED] === true) return table;
  Object.setPrototypeOf(table, variantProto(table));
  Object.defineProperty(table, INSTALLED, { value: true, enumerable: false });
  return table;
}
const INSTALLED = Symbol.for('saltline.ships.variants');

/** The contract's form (§7.2): a Proxy over the rows; enumeration = the rows' own keys only. */
export function classesProxy(rows) {
  return new Proxy(rows, {
    get: (t, k) => (typeof k === 'string' && !(k in t) ? classRow(k, t) ?? undefined : t[k]),
    has: (t, k) => (k in t) || (typeof k === 'string' && !!classRow(k, t)),
  });
}
