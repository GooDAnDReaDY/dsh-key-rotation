// lib/quota.js — quota-remaining persistence per ref.
// ponytail: pure helpers, snapshot() returns shallow copies.

export class QuotaStore {
  constructor() {
    this._data = new Map(); // ref -> { remaining, limit, reset, at }
  }

  set(ref, info) {
    if (!ref) return;
    if (!info || typeof info !== 'object') return;
    const next = {
      remaining: Number.isFinite(info.remaining) ? info.remaining : null,
      limit: Number.isFinite(info.limit) ? info.limit : null,
      reset: Number.isFinite(info.reset) ? info.reset : null,
      at: Number.isFinite(info.at) ? info.at : Date.now(),
    };
    this._data.set(ref, next);
  }

  get(ref) {
    return this._data.get(ref);
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._data) out[k] = v;
    return out;
  }

  clear(ref) {
    if (ref) this._data.delete(ref);
    else this._data.clear();
  }

  get size() {
    return this._data.size;
  }
}
