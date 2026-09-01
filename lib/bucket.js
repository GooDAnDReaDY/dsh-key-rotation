// lib/bucket.js - per-key RPM token bucket (#192).
// ponytail: RPM only - true token counts are not visible before the stream
// starts; wire TPM in when pi-ai surfaces usage on the resolve path.
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

/** #210: snapshot for /status - used/remaining/resetMs for one ref. */
export function bucketInfo(windows, ref, limit, now = Date.now()) {
  if (!limit || limit <= 0) return null;
  const hits = (windows?.get(ref) ?? []).filter((t) => t > now - WINDOW_MS);
  return {
    used: hits.length,
    remaining: Math.max(0, limit - hits.length),
    resetMs: hits.length ? Math.max(0, hits[0] + WINDOW_MS - now) : 0,
  };
}
