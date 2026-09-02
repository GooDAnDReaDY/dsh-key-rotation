// lib/bucket.js - per-key RPM token bucket (#192) + O(1) accumulator and adaptive tuning.
const WINDOW_MS = 60000;

/**
 * O(1) Mathematical Token Bucket Accumulator.
 * tokens = min(capacity, tokens + (now - lastRefill) * refillRate)
 */
export class TokenBucketAccumulator {
  constructor(capacity, windowMs = WINDOW_MS, now = Date.now()) {
    this.capacity = Math.max(1, capacity);
    this.tokens = this.capacity;
    this.windowMs = windowMs;
    this.refillRate = this.capacity / this.windowMs; // tokens per ms
    this.lastRefill = now;
  }

  refill(now = Date.now()) {
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
      this.lastRefill = now;
    }
  }

  allow(cost = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  retryMs(cost = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens >= cost) return 0;
    const needed = cost - this.tokens;
    return Math.ceil(needed / this.refillRate);
  }

  updateCapacity(newCapacity, now = Date.now()) {
    this.refill(now);
    const prevCap = this.capacity;
    this.capacity = Math.max(1, newCapacity);
    this.refillRate = this.capacity / this.windowMs;
    // Scale current tokens proportionally or clamp
    this.tokens = Math.min(this.capacity, Math.max(0, this.tokens + (this.capacity - prevCap)));
  }

  info(now = Date.now()) {
    this.refill(now);
    const used = Math.max(0, Math.round(this.capacity - this.tokens));
    const remaining = Math.max(0, Math.floor(this.tokens));
    return {
      used,
      remaining,
      resetMs: this.retryMs(1, now),
      capacity: this.capacity,
    };
  }
}

/** Sliding-window check: true if `ref` is under `limit` requests/min. */
export function bucketAllow(windows, ref, limit, now = Date.now()) {
  if (!limit || limit <= 0) return true;
  const cut = now - WINDOW_MS;
  const hits = (windows.get(ref) ?? []).filter((t) => t > cut);
  if (hits.length >= limit) {
    windows.set(ref, hits);
    return false;
  }
  hits.push(now);
  windows.set(ref, hits);
  return true;
}

/** Record a hit without checking (use after a successful resolve). */
export function bucketHit(windows, ref, now = Date.now()) {
  const cut = now - WINDOW_MS;
  const hits = (windows.get(ref) ?? []).filter((t) => t > cut);
  hits.push(now);
  windows.set(ref, hits);
}

/** ms until `ref` may retry again (0 = now). */
export function bucketRetryMs(windows, ref, limit, now = Date.now()) {
  if (!limit || limit <= 0) return 0;
  const hits = (windows.get(ref) ?? []).filter((t) => t > now - WINDOW_MS);
  if (hits.length < limit) return 0;
  return Math.max(0, hits[0] + WINDOW_MS - now);
}

/** Drop state for refs that no longer exist. */
export function bucketSweep(windows, liveRefs) {
  for (const ref of [...windows.keys()]) {
    if (!liveRefs.has(ref)) windows.delete(ref);
  }
}

/** Snapshot for /status - used/remaining/resetMs for one ref. */
export function bucketInfo(windows, ref, limit, now = Date.now()) {
  if (!limit || limit <= 0) return null;
  const hits = (windows?.get(ref) ?? []).filter((t) => t > now - WINDOW_MS);
  return {
    used: hits.length,
    remaining: Math.max(0, limit - hits.length),
    resetMs: hits.length ? Math.max(0, hits[0] + WINDOW_MS - now) : 0,
  };
}

/**
 * Adaptive limit computation from HTTP headers with manual limit precedence.
 * If manualLimit is given (> 0), it acts as the upper ceiling.
 * If adaptive is enabled and upstream reports a lower limit/remaining, adapt downwards.
 */
export function computeEffectiveLimit(headerRateLimit, manualLimit, adaptiveEnabled = true) {
  const manual = (Number.isFinite(manualLimit) && manualLimit > 0) ? manualLimit : null;
  if (!adaptiveEnabled || !headerRateLimit) {
    return manual;
  }
  const headerLimit = headerRateLimit.limit;
  if (Number.isFinite(headerLimit) && headerLimit > 0) {
    if (manual) {
      return Math.min(manual, headerLimit); // manual acts as upper ceiling
    }
    return headerLimit;
  }
  return manual;
}