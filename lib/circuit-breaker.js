// lib/circuit-breaker.js — per-provider circuit breaker (#260).
// closed --(threshold consecutive failures)--> open --(openMs)--> half-open
// half-open: allow limited probes; success => closed, failure => open again.

export const BREAKER_CLOSED = 'closed';
export const BREAKER_OPEN = 'open';
export const BREAKER_HALF_OPEN = 'half_open';

export class CircuitBreaker {
  /**
   * @param {{ threshold?: number, openMs?: number, halfOpenProbes?: number, now?: () => number }} opts
   */
  constructor({ threshold = 5, openMs = 30_000, halfOpenProbes = 1, now = Date.now } = {}) {
    this.configure({ threshold, openMs, halfOpenProbes });
    this._now = now;
    /** @type {Map<string, {state:string, fails:number, openedAt:number, probes:number, generation:number}>} */
    this._st = new Map();
  }

  configure({ threshold = 5, openMs = 30_000, halfOpenProbes = 1 } = {}) {
    const integer = (value, fallback, min) => Number.isFinite(value)
      ? Math.max(min, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : fallback;
    this.threshold = integer(threshold, 5, 1);
    this.openMs = integer(openMs, 30_000, 100);
    this.halfOpenProbes = integer(halfOpenProbes, 1, 1);
  }

  _entry(provider) {
    let e = this._st.get(provider);
    if (!e) {
      e = { state: BREAKER_CLOSED, fails: 0, openedAt: 0, probes: 0, generation: 0 };
      this._st.set(provider, e);
    }
    return e;
  }

  /** @returns {boolean} whether a request may be dispatched to this provider */
  canRequest(provider) {
    const e = this._entry(provider);
    const now = this._now();
    if (e.state === BREAKER_OPEN) {
      if (now - e.openedAt >= this.openMs) {
        e.state = BREAKER_HALF_OPEN;
        e.probes = 0;
        e.generation += 1;
      } else {
        return false;
      }
    }
    if (e.state === BREAKER_HALF_OPEN) {
      if (e.probes < this.halfOpenProbes) {
        e.probes += 1;
        return true;
      }
      return false;
    }
    return true;
  }

  // A permit is settled exactly once. Late outcomes from an older circuit
  // generation (or a removed provider) cannot close/reopen a newer circuit.
  acquire(provider) {
    if (!this.canRequest(provider)) return null;
    const entry = this._entry(provider);
    const generation = entry.generation;
    const probing = entry.state === BREAKER_HALF_OPEN;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (this._st.get(provider) === entry && entry.generation === generation) fn();
    };
    return {
      success: () => settle(() => this.onSuccess(provider)),
      failure: () => settle(() => this.onFailure(provider)),
      release: () => settle(() => {
        if (probing && entry.state === BREAKER_HALF_OPEN) {
          entry.probes = Math.max(0, entry.probes - 1);
        }
      }),
    };
  }

  onSuccess(provider) {
    const e = this._entry(provider);
    if (e.state !== BREAKER_CLOSED) e.generation += 1;
    e.fails = 0;
    e.probes = 0;
    e.openedAt = 0;
    e.state = BREAKER_CLOSED;
  }

  onFailure(provider) {
    const e = this._entry(provider);
    const now = this._now();
    // In-flight failures arriving after opening must not extend the cooldown.
    if (e.state === BREAKER_OPEN) return e.state;
    if (e.state === BREAKER_HALF_OPEN) {
      e.state = BREAKER_OPEN;
      e.openedAt = now;
      e.fails = this.threshold;
      e.probes = 0;
      e.generation += 1;
      return e.state;
    }
    e.fails += 1;
    if (e.fails >= this.threshold) {
      e.state = BREAKER_OPEN;
      e.openedAt = now;
      e.probes = 0;
      e.generation += 1;
    }
    return e.state;
  }

  state(provider) {
    return this._entry(provider).state;
  }

  snapshot() {
    const out = {};
    for (const [k, e] of this._st) {
      out[k] = { state: e.state, fails: e.fails, openedAt: e.state === BREAKER_CLOSED ? null : e.openedAt };
    }
    return out;
  }

  reset(provider) {
    if (provider) this._st.delete(provider);
    else this._st.clear();
  }

  /** Restore entries from a persistence snapshot (#287). */
  restore(snapshot, { preserveExisting = false } = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 0;
    let n = 0;
    for (const [provider, e] of Object.entries(snapshot)) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      if (preserveExisting && this._st.has(provider)) continue;
      const state = e.state === BREAKER_OPEN || e.state === BREAKER_HALF_OPEN ? e.state : BREAKER_CLOSED;
      this._st.set(provider, {
        state,
        fails: Number.isFinite(e.fails) ? e.fails : 0,
        openedAt: Number.isFinite(e.openedAt) ? e.openedAt : 0,
        probes: 0,
        generation: 0,
      });
      n += 1;
    }
    return n;
  }
}
