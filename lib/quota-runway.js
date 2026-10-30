// lib/quota-runway.js — Predictive Quota Runway and burn rate estimation (#549).
// Estimates time to quota exhaustion and preemptively rotates keys before hitting HTTP 429.

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const DEFAULT_WINDOW_DURATIONS = {
  minute: MINUTE,
  fiveMinute: 5 * MINUTE,
  hourly: HOUR,
  daily: DAY,
  monthly: 30 * DAY,
};

/**
 * Bounds percentage value to [0, 100].
 * @param {number|unknown} value
 * @returns {number}
 */
export function clampPercent(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 0;
}

/**
 * Estimates when a quota window reaches 100% at the average burn rate observed.
 *
 * @param {object|undefined} window
 * @param {number} window.percentUsed Current percentage used (0..100)
 * @param {string|number} window.resetsAt ISO timestamp or epoch ms when window resets
 * @param {number} durationMs Window duration in milliseconds
 * @param {number} [now] Current epoch timestamp in milliseconds
 * @returns {{
 *   etaMs: number,
 *   resetsAtMs: number,
 *   exhaustsBeforeReset: boolean,
 *   burnRatePerSec: number
 * } | null}
 */
export function estimateRunway(window, durationMs, now = Date.now()) {
  if (!window || window.resetsAt == null || !durationMs || durationMs <= 0) return null;

  const resetsAtMs = typeof window.resetsAt === 'number' ? window.resetsAt : Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now) return null;

  const used = clampPercent(window.percentUsed);
  const timeToReset = resetsAtMs - now;

  // Already 100% or more: exhausts immediately
  if (used >= 100) {
    return {
      etaMs: 0,
      resetsAtMs,
      exhaustsBeforeReset: true,
      burnRatePerSec: 0,
    };
  }

  const startedAt = resetsAtMs - durationMs;
  const elapsed = Math.max(1, now - startedAt);
  const ratePerMs = used / elapsed;

  if (!Number.isFinite(ratePerMs) || ratePerMs <= 0) {
    return {
      etaMs: Number.POSITIVE_INFINITY,
      resetsAtMs,
      exhaustsBeforeReset: false,
      burnRatePerSec: 0,
    };
  }

  const remainingPercent = 100 - used;
  const etaMs = remainingPercent / ratePerMs;
  const exhaustsBeforeReset = etaMs < timeToReset;
  const burnRatePerSec = ratePerMs * 1000;

  return {
    etaMs,
    resetsAtMs,
    exhaustsBeforeReset,
    burnRatePerSec,
  };
}

/**
 * Stateful Quota Runway tracker for credentials and pools.
 */
export class QuotaRunway {
  /**
   * @param {object} [options]
   * @param {number} [options.slidingWindowMs]
   */
  constructor(options = {}) {
    this.slidingWindowMs = options.slidingWindowMs ?? (5 * MINUTE);
    /** @type {Map<string, Array<{ at: number, amount: number }>>} */
    this.samples = new Map();
    /** @type {Map<string, { limit: number, remaining: number, resetsAtMs: number, durationMs: number }>} */
    this.knownLimits = new Map();
  }

  /**
   * Records usage tokens or requests for a key.
   * @param {string} keyRef
   * @param {number} amount
   * @param {number} [now]
   */
  recordUsage(keyRef, amount, now = Date.now()) {
    if (!keyRef || !amount || amount <= 0) return;
    let list = this.samples.get(keyRef);
    if (!list) {
      list = [];
      this.samples.set(keyRef, list);
    }
    list.push({ at: now, amount });
    this._prune(keyRef, now);
  }

  /**
   * Updates key limits detected from response headers or provider metadata.
   * @param {string} keyRef
   * @param {object} limits
   * @param {number} [limits.limit]
   * @param {number} [limits.remaining]
   * @param {number|string} [limits.resetsAt]
   * @param {number} [limits.durationMs]
   * @param {number} [now]
   */
  updateLimits(keyRef, limits, now = Date.now()) {
    if (!keyRef || !limits) return;
    const limit = Number(limits.tpmLimit ?? limits.rpmLimit ?? limits.limit);
    const remaining = Number(limits.remainingTokens ?? limits.remainingRequests ?? limits.remaining);
    const resetSec = Number(limits.resetTokens ?? limits.resetRequests ?? limits.retryAfter);

    let resetsAtMs = NaN;
    if (Number.isFinite(resetSec)) {
      resetsAtMs = now + (resetSec * 1000);
    } else if (limits.resetsAt || limits.resetAt) {
      const at = limits.resetsAt || limits.resetAt;
      resetsAtMs = typeof at === 'number' ? at : Date.parse(at);
    }

    const durationMs = Number(limits.durationMs) || DEFAULT_WINDOW_DURATIONS.minute;

    if (Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(resetsAtMs)) {
      this.knownLimits.set(keyRef, {
        limit,
        remaining,
        resetsAtMs,
        durationMs,
      });
    }
  }

  /**
   * Checks if key is projected to exhaust its quota before the current window resets.
   * @param {string} keyRef
   * @param {number} [now]
   * @returns {boolean}
   */
  isExhaustingBeforeReset(keyRef, now = Date.now()) {
    const assessment = this.assessRunway(keyRef, now);
    return Boolean(assessment?.exhaustsBeforeReset);
  }

  /**
   * Returns complete runway assessment for a key.
   * @param {string} keyRef
   * @param {number} [now]
   * @returns {{
   *   exhaustsBeforeReset: boolean,
   *   etaMs: number,
   *   burnRatePerSec: number,
   *   timeToResetMs: number
   * } | null}
   */
  assessRunway(keyRef, now = Date.now()) {
    if (!keyRef) return null;

    const limits = this.knownLimits.get(keyRef);
    if (!limits || limits.resetsAtMs <= now) {
      return null;
    }

    const { limit, remaining, resetsAtMs, durationMs } = limits;
    if (limit <= 0) return null;

    const used = Math.max(0, limit - remaining);
    const percentUsed = (used / limit) * 100;

    const estimate = estimateRunway(
      { percentUsed, resetsAt: resetsAtMs },
      durationMs,
      now,
    );

    if (!estimate) return null;

    return {
      exhaustsBeforeReset: estimate.exhaustsBeforeReset,
      etaMs: estimate.etaMs,
      burnRatePerSec: estimate.burnRatePerSec,
      timeToResetMs: resetsAtMs - now,
    };
  }

  _prune(keyRef, now) {
    const list = this.samples.get(keyRef);
    if (!list) return;
    const cutoff = now - this.slidingWindowMs;
    while (list.length > 0 && list[0].at < cutoff) {
      list.shift();
    }
  }

  clear() {
    this.samples.clear();
    this.knownLimits.clear();
  }
}

export const defaultQuotaRunway = new QuotaRunway();
