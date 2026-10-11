// lib/request-budget.js — per-request deadline & attempt budget management (#464).
// Monotonic clock timing via nowMono(), abort signal chaining, and dispatch attempt tracking.
import { nowMono } from './clock.js';

export const BUDGET_EXHAUSTED_TIMEOUT = 'BUDGET_DEADLINE_EXCEEDED';
export const BUDGET_EXHAUSTED_ATTEMPTS = 'BUDGET_ATTEMPTS_EXCEEDED';

/**
 * Creates or normalizes a RequestBudget for rotation and cascade.
 * @param {object} [options]
 * @param {number} [options.maxDurationMs] - Max total wall duration in ms (0 = unlimited).
 * @param {number} [options.maxAttempts] - Max total upstream dispatch attempts (0 = unlimited).
 * @param {AbortSignal} [options.signal] - Caller-provided abort signal.
 * @returns {object}
 */
export function createRequestBudget(options = {}) {
  const maxDurationMs = Math.max(0, Number(options.maxDurationMs) || 0);
  const maxAttempts = Math.max(0, Number(options.maxAttempts) || 0);
  const startTime = nowMono();
  const deadline = maxDurationMs > 0 ? startTime + maxDurationMs : Infinity;
  let attempts = 0;

  const controller = new AbortController();
  let timerId = null;

  // Chain caller signal if provided
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      const onCallerAbort = () => {
        controller.abort(options.signal.reason);
        cleanup();
      };
      options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  // Setup deadline timeout if finite
  if (Number.isFinite(deadline)) {
    const remaining = Math.max(0, deadline - startTime);
    timerId = setTimeout(() => {
      const err = new Error(`Request exceeded maximum deadline of ${maxDurationMs}ms`);
      err.code = BUDGET_EXHAUSTED_TIMEOUT;
      controller.abort(err);
    }, remaining);
    if (timerId.unref) timerId.unref();
  }

  function cleanup() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  return {
    startTime,
    maxDurationMs,
    maxAttempts,
    deadline,
    signal: controller.signal,

    /** Check if deadline is expired */
    isExpired() {
      if (controller.signal.aborted) return true;
      if (Number.isFinite(deadline) && nowMono() >= deadline) {
        return true;
      }
      return false;
    },

    /** Remaining time in ms before deadline (or Infinity if none) */
    remainingMs() {
      if (controller.signal.aborted) return 0;
      if (!Number.isFinite(deadline)) return Infinity;
      return Math.max(0, Math.round(deadline - nowMono()));
    },

    /** Current count of attempted dispatches */
    getAttempts() {
      return attempts;
    },

    /** Check whether another attempt is permitted */
    canAttempt() {
      if (this.isExpired()) return false;
      if (maxAttempts > 0 && attempts >= maxAttempts) return false;
      return true;
    },

    /** Record a real upstream dispatch attempt */
    recordAttempt() {
      if (!this.canAttempt()) {
        const err = new Error(
          this.isExpired()
            ? `Request exceeded maximum duration (${maxDurationMs}ms)`
            : `Request exceeded maximum attempts (${maxAttempts})`
        );
        err.code = this.isExpired() ? BUDGET_EXHAUSTED_TIMEOUT : BUDGET_EXHAUSTED_ATTEMPTS;
        throw err;
      }
      attempts += 1;
      return attempts;
    },

    /** Cleanup timers / listeners */
    dispose() {
      cleanup();
    }
  };
}
