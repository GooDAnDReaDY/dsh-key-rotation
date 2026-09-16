// lib/bucket.js - per-key RPM token bucket (#192).
const WINDOW_MS = 60000;

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

