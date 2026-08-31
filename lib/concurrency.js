// concurrency.js — per-key in-flight counter + least-connections picking (issue #193).

export const CONCURRENCY_DEFAULT_LIMIT = 0;
export const CONCURRENCY_STALE_LOCK_MS = 5 * 60 * 1000;

export class ConcurrencyTracker {
  constructor(opts) {
    opts = opts || {};
    const limit = opts.limit !== undefined ? opts.limit : CONCURRENCY_DEFAULT_LIMIT;
    this._limit = (Number.isFinite(limit) && limit >= 0) ? Math.floor(limit) : 0;
    this._staleMs = opts.staleMs || CONCURRENCY_STALE_LOCK_MS;
    this._inFlight = new Map();
  }

  isEnabled() { return this._limit > 0; }
  get limit() { return this._limit; }

  acquire(ref, now) {
    now = now || Date.now();
    if (!this.isEnabled()) return true;
    let e = this._inFlight.get(ref);
    if (!e) {
      e = { count: 0, lastAcquired: now };
      this._inFlight.set(ref, e);
    }
    if (now - e.lastAcquired > this._staleMs) {
      e.count = 0;
    }
    if (e.count >= this._limit) return false;
    e.count += 1;
    e.lastAcquired = now;
    return true;
  }

  release(ref, now) {
    now = now || Date.now();
    const e = this._inFlight.get(ref);
    if (!e) return;
    e.count = Math.max(0, e.count - 1);
    e.lastAcquired = now;
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._inFlight) out[k] = { count: v.count };
    return out;
  }

  pickLeastLoaded(candidates, now) {
    now = now || Date.now();
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    let best = null;
    let bestCount = Infinity;
    for (const ref of candidates) {
      const e = this._inFlight.get(ref);
      const count = e ? e.count : 0;
      if (this.isEnabled() && count >= this._limit) continue;
      if (count < bestCount) {
        best = ref;
        bestCount = count;
      }
    }
    return best;
  }

  clear(ref) {
    if (ref) this._inFlight.delete(ref);
    else this._inFlight.clear();
  }

  get size() { return this._inFlight.size; }
}
