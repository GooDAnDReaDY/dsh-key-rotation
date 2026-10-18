// lib/traffic-smoother.js — leaky bucket micro-queue traffic smoother (#496).
// Absorbs momentary request bursts without tripping upstream per-second/per-minute rate limits.

export class TrafficSmoother {
  constructor({ maxQueueWaitMs = 800, now = Date.now, sleep = null } = {}) {
    this.maxQueueWaitMs = maxQueueWaitMs;
    this.now = now;
    this.sleep = sleep || ((ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      }
    }));
    // Map<ref, { lastTime: number, tokens: number, lastUpdate: number }>
    this._buckets = new Map();
  }

  /**
   * Acquire a slot for `ref` given effective RPM or burst limits.
   * @param {string} ref
   * @param {object} opts { rpmLimit, burstLimit, maxQueueWaitMs, signal }
   * @returns {Promise<{ allowed: boolean, delayed: boolean, delayMs: number, overflow: boolean }>}
   */
  async acquire(ref, { rpmLimit, burstLimit, maxQueueWaitMs, signal } = {}) {
    if (!ref) {
      return { allowed: true, delayed: false, delayMs: 0, overflow: false };
    }
    const maxWait = typeof maxQueueWaitMs === 'number' && maxQueueWaitMs >= 0 ? maxQueueWaitMs : this.maxQueueWaitMs;
    const effectiveRpm = Number(rpmLimit) > 0 ? Number(rpmLimit) : 0;
    if (effectiveRpm <= 0) {
      return { allowed: true, delayed: false, delayMs: 0, overflow: false };
    }

    const capacity = Number(burstLimit) > 0
      ? Math.floor(burstLimit)
      : Math.max(2, Math.ceil(effectiveRpm / 12));

    const ratePerSec = effectiveRpm / 60; // tokens per second
    const intervalMs = Math.max(1, 1000 / ratePerSec); // ms between tokens
    const curNow = this.now();

    let bucket = this._buckets.get(ref);
    if (!bucket) {
      bucket = { tokens: capacity, lastUpdate: curNow, nextSlot: curNow };
      this._buckets.set(ref, bucket);
    }

    // Replenish tokens based on elapsed time
    const elapsed = Math.max(0, curNow - bucket.lastUpdate);
    const addedTokens = elapsed * (ratePerSec / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + addedTokens);
    bucket.lastUpdate = curNow;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      bucket.nextSlot = Math.max(curNow, bucket.nextSlot);
      return { allowed: true, delayed: false, delayMs: 0, overflow: false };
    }

    // Burst is exhausted: calculate delay required for next available slot
    const targetSlot = Math.max(curNow, bucket.nextSlot) + intervalMs;
    const delayMs = Math.max(0, targetSlot - curNow);

    if (delayMs > maxWait) {
      // Exceeds max micro-queue wait: signal overflow so caller rotates to next candidate
      return { allowed: false, delayed: false, delayMs, overflow: true };
    }

    bucket.nextSlot = targetSlot;

    // Wait for the scheduled slot
    await this.sleep(delayMs, signal);

    return { allowed: true, delayed: true, delayMs, overflow: false };
  }

  getQueueDepth(ref) {
    if (!ref) return this._buckets.size;
    const b = this._buckets.get(ref);
    if (!b) return 0;
    const curNow = this.now();
    const wait = Math.max(0, b.nextSlot - curNow);
    return wait > 0 ? Math.ceil(wait / 100) : 0;
  }

  clear(ref) {
    if (ref) this._buckets.delete(ref);
    else this._buckets.clear();
  }
}

export default TrafficSmoother;
