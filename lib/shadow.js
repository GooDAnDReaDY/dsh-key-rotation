// lib/shadow.js — shadow A/B traffic sampling.
// ponytail: per-provider counter, simple percent gating.

export const SHADOW_DEFAULT_PERCENT = 0;  // 0 = disabled
export const SHADOW_BUCKET = 100;        // percent base

export class ShadowRouter {
  constructor({ primary, secondary, percent = SHADOW_DEFAULT_PERCENT } = {}) {
    this._primary = primary || '';
    this._secondary = secondary || '';
    this._percent = Number.isFinite(percent) && percent > 0 ? Math.min(SHADOW_BUCKET, Math.floor(percent)) : 0;
    this._sent = 0;
    this._shadowed = 0;
    this._latencySumPrimary = 0;
    this._latencySumSecondary = 0;
    this._latencyCountPrimary = 0;
    this._latencyCountSecondary = 0;
  }

  isEnabled() {
    return this._percent > 0 && Boolean(this._primary) && Boolean(this._secondary) && this._primary !== this._secondary;
  }

  pick(requestHash = Math.random()) {
    if (!this.isEnabled()) return { primary: this._primary, secondary: null, sampled: false };
    // Convert requestHash to [0, SHADOW_BUCKET)
    let h;
    if (typeof requestHash === 'number') {
      h = Math.floor(requestHash * SHADOW_BUCKET);
    } else {
      // Stable hash: fnv1a-lite on string
      let str = String(requestHash);
      let x = 2166136261;
      for (let i = 0; i < str.length; i++) {
        x ^= str.charCodeAt(i);
        x = (x * 16777619) >>> 0;
      }
      h = x % SHADOW_BUCKET;
    }
    const sampled = h < this._percent;
    this._sent += 1;
    if (sampled) this._shadowed += 1;
    return { primary: this._primary, secondary: sampled ? this._secondary : null, sampled };
  }

  recordLatency(target, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (target === this._primary) {
      this._latencySumPrimary += ms;
      this._latencyCountPrimary += 1;
    } else if (target === this._secondary) {
      this._latencySumSecondary += ms;
      this._latencyCountSecondary += 1;
    }
  }

  snapshot() {
    const avg = (sum, count) => (count > 0 ? sum / count : null);
    return {
      primary: this._primary,
      secondary: this._secondary,
      percent: this._percent,
      enabled: this.isEnabled(),
      sent: this._sent,
      shadowed: this._shadowed,
      avgLatencyMs: {
        primary: avg(this._latencySumPrimary, this._latencyCountPrimary),
        secondary: avg(this._latencySumSecondary, this._latencyCountSecondary),
      },
    };
  }

  reset() {
    this._sent = 0;
    this._shadowed = 0;
    this._latencySumPrimary = 0;
    this._latencySumSecondary = 0;
    this._latencyCountPrimary = 0;
    this._latencyCountSecondary = 0;
  }
}
