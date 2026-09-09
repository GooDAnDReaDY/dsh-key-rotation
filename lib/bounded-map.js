// lib/bounded-map.js — Map with max size + optional TTL (#262).

export class BoundedMap {
  /** @param {{ max?: number, ttlMs?: number|null }} opts */
  constructor({ max = 1000, ttlMs = null } = {}) {
    if (!Number.isFinite(max) || max < 1) throw new Error('BoundedMap: max must be >= 1');
    this.max = max;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : null;
    this._m = new Map(); // insertion order = LRU order when we re-insert on get/set
  }

  get size() { return this._m.size; }

  _expired(entry, now) {
    if (!this.ttlMs || !entry) return false;
    return now - entry.at >= this.ttlMs;
  }

  get(key, now = Date.now()) {
    const e = this._m.get(key);
    if (!e) return undefined;
    if (this._expired(e, now)) {
      this._m.delete(key);
      return undefined;
    }
    // refresh LRU
    this._m.delete(key);
    this._m.set(key, e);
    return e.v;
  }

  set(key, value, now = Date.now()) {
    if (this._m.has(key)) this._m.delete(key);
    this._m.set(key, { v: value, at: now });
    while (this._m.size > this.max) {
      const oldest = this._m.keys().next().value;
      this._m.delete(oldest);
    }
    return this;
  }

  has(key, now = Date.now()) {
    return this.get(key, now) !== undefined;
  }

  delete(key) { return this._m.delete(key); }
  clear() { this._m.clear(); }

  *entries(now = Date.now()) {
    for (const [k, e] of [...this._m.entries()]) {
      if (this._expired(e, now)) { this._m.delete(k); continue; }
      yield [k, e.v];
    }
  }

  *keys(now = Date.now()) {
    for (const [k] of this.entries(now)) yield k;
  }

  toObject(now = Date.now()) {
    const out = {};
    for (const [k, v] of this.entries(now)) out[k] = v;
    return out;
  }
}
