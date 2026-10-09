// A Map with a byte budget: least recently used entries are dropped once the sum of their sizes passes `maxBytes`.
// get() / has() do NOT change the order (sync physics reads must stay cheap); touch() / set() make an entry the most
// recent. `pinned(key, value)` → true keeps an entry through a trim (it still counts toward the bytes); an entry
// larger than the whole budget is still kept while it is the newest one, so a single item always fits.
export class ByteLRU {
  /** opts: { maxBytes, sizeOf(value) → bytes, onEvict(key, value), pinned(key, value) → bool } */
  constructor({ maxBytes = 64 * 1048576, sizeOf = () => 0, onEvict = null, pinned = null } = {}) {
    this.map = new Map();        // key → { v, b }
    this.maxBytes = maxBytes; this.sizeOf = sizeOf; this.onEvict = onEvict; this.pinned = pinned;
    this.bytes = 0; this.evictions = 0;
  }
  get size() { return this.map.size; }
  has(k) { return this.map.has(k); }
  get(k) { const e = this.map.get(k); return e ? e.v : undefined; }
  /** Make `k` the most recently used; true when present. */
  touch(k) { const e = this.map.get(k); if (!e) return false; this.map.delete(k); this.map.set(k, e); return true; }
  set(k, v, bytes = null) {
    const old = this.map.get(k);
    if (old) { this.bytes -= old.b; this.map.delete(k); }
    const b = Math.max(0, Number(bytes ?? this.sizeOf(v)) || 0);
    this.map.set(k, { v, b }); this.bytes += b;
    this.trim();
    return this;
  }
  /** Re-measure one entry (its value grew / shrank, e.g. an SDF was attached) and trim. */
  resize(k) { const e = this.map.get(k); if (!e) return; const b = Math.max(0, Number(this.sizeOf(e.v)) || 0); this.bytes += b - e.b; e.b = b; this.trim(); }
  delete(k) { const e = this.map.get(k); if (!e) return false; this.map.delete(k); this.bytes -= e.b; return true; }
  clear() { this.map.clear(); this.bytes = 0; }
  /** Drop least recently used, unpinned entries until bytes ≤ max (default: the budget). Returns the number dropped. */
  trim(max = this.maxBytes, filter = null) {
    if (this.bytes <= max) return 0;
    let n = 0;
    const newest = [...this.map.keys()].pop();
    for (const [k, e] of this.map) {
      if (this.bytes <= max) break;
      if (k === newest && !filter) continue;
      if (this.pinned && this.pinned(k, e.v)) continue;
      if (filter && !filter(k, e.v)) continue;
      this.map.delete(k); this.bytes -= e.b; this.evictions++; n++;
      if (this.onEvict) { try { this.onEvict(k, e.v); } catch { /* listener errors stay there */ } }
    }
    return n;
  }
  /** Drop every entry for which `drop(key, value)` is true (pins ignored: the caller decides). Returns the count. */
  dropWhere(drop) {
    let n = 0;
    for (const [k, e] of [...this.map]) if (drop(k, e.v)) { this.map.delete(k); this.bytes -= e.b; this.evictions++; n++; if (this.onEvict) { try { this.onEvict(k, e.v); } catch { /* never */ } } }
    return n;
  }
  keys() { return this.map.keys(); }
  *values() { for (const e of this.map.values()) yield e.v; }
  *entries() { for (const [k, e] of this.map) yield [k, e.v]; }
  [Symbol.iterator]() { return this.entries(); }
}
