// lib/traffic-smoother.js — GCRA leaky bucket micro-queue traffic smoother (#496, #538).
// Absorbs momentary request bursts without tripping upstream per-second/per-minute rate limits.
// Uses Generic Cell Rate Algorithm to ensure atomic slot reservation and burst compliance.

export class TrafficSmoother {
  constructor({ maxQueueWaitMs = 800, now = Date.now, sleep = null } = {}) {
    this.maxQueueWaitMs = maxQueueWaitMs;
    this.now = now;
    this.sleep = sleep || ((ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const err = (signal.reason instanceof Error) ? signal.reason : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
        return reject(err);
      }
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = (signal.reason instanceof Error) ? signal.reason : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
          reject(err);
        }, { once: true });
      }
    }));
    // Map<ref, { virtualTime: number }>
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
      bucket = { virtualTime: curNow - capacity * intervalMs };
      this._buckets.set(ref, bucket);
    }

    // GCRA: virtualTime cannot fall behind (curNow - capacity * intervalMs)
    const minVirtualTime = curNow - capacity * intervalMs;
    const vTime = Math.max(minVirtualTime, bucket.virtualTime);
    const targetSlot = vTime + intervalMs;

    if (targetSlot <= curNow) {
      // Immediate acquisition within available burst capacity
      bucket.virtualTime = targetSlot;
      return { allowed: true, delayed: false, delayMs: 0, overflow: false };
    }

    // Queue delay required
    const delayMs = targetSlot - curNow;

    if (delayMs > maxWait) {
      // Exceeds max micro-queue wait: signal overflow so caller rotates to next candidate
      return { allowed: false, delayed: false, delayMs, overflow: true };
    }

    // Atomically reserve the slot ahead of sleeping (#538)
    bucket.virtualTime = targetSlot;

    try {
      await this.sleep(delayMs, signal);
    } catch (err) {
      // Rollback reservation if this was the last queued request
      if (bucket.virtualTime === targetSlot) {
        bucket.virtualTime = Math.max(minVirtualTime, targetSlot - intervalMs);
      }
      throw err;
    }

    return { allowed: true, delayed: true, delayMs, overflow: false };
  }

  getQueueDepth(ref) {
    if (!ref) return this._buckets.size;
    const b = this._buckets.get(ref);
    if (!b) return 0;
    const curNow = this.now();
    const wait = Math.max(0, b.virtualTime - curNow);
    return wait > 0 ? Math.ceil(wait / 100) : 0;
  }

  clear(ref) {
    if (ref) this._buckets.delete(ref);
    else this._buckets.clear();
  }
}

export default TrafficSmoother;
