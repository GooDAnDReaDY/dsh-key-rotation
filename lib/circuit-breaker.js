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
    this.threshold = Math.max(1, threshold | 0);
    this.openMs = Math.max(100, openMs | 0);
    this.halfOpenProbes = Math.max(1, halfOpenProbes | 0);
    this._now = now;
    /** @type {Map<string, {state:string, fails:number, openedAt:number, probes:number}>} */
    this._st = new Map();
  }

  _entry(provider) {
    let e = this._st.get(provider);
    if (!e) {
      e = { state: BREAKER_CLOSED, fails: 0, openedAt: 0, probes: 0 };
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
        return true;
      }
      return false;
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

  onSuccess(provider) {
    const e = this._entry(provider);
    e.fails = 0;
    e.probes = 0;
    e.state = BREAKER_CLOSED;
  }

  onFailure(provider) {
    const e = this._entry(provider);
    const now = this._now();
    if (e.state === BREAKER_HALF_OPEN) {
      e.state = BREAKER_OPEN;
      e.openedAt = now;
      e.fails = this.threshold;
      return e.state;
    }
    e.fails += 1;
    if (e.fails >= this.threshold) {
      e.state = BREAKER_OPEN;
      e.openedAt = now;
    }
    return e.state;
  }

  state(provider) {
    return this._entry(provider).state;
  }

  snapshot() {
    const out = {};
    for (const [k, e] of this._st) {
      out[k] = { state: e.state, fails: e.fails, openedAt: e.openedAt || null };
    }
    return out;
  }

  reset(provider) {
    if (provider) this._st.delete(provider);
    else this._st.clear();
  }
}
