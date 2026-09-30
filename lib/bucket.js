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


/** Sliding-window check: true if `ref` is under `limit` tokens/min. */
export function tpmAllow(windows, ref, limit, now = Date.now()) {
  if (!limit || limit <= 0) return true;
  const cut = now - WINDOW_MS;
  const entries = (windows?.get(ref) ?? []).filter((e) => e.time > cut);
  let total = 0;
  for (const e of entries) total += e.tokens;
  return total < limit;
}

/** Record actual consumed tokens for `ref` in sliding 60s window. */
export function tpmRecord(windows, ref, tokens, now = Date.now()) {
  if (!tokens || tokens <= 0 || !windows) return;
  const cut = now - WINDOW_MS;
  const validTokens = Math.max(1, Math.floor(tokens));
  const entries = (windows.get(ref) ?? []).filter((e) => e.time > cut);
  entries.push({ time: now, tokens: validTokens });
  windows.set(ref, entries);
}

/** ms until `ref` may retry again under TPM limit (0 = now). */
export function tpmRetryMs(windows, ref, limit, now = Date.now()) {
  if (!limit || limit <= 0) return 0;
  const cut = now - WINDOW_MS;
  const entries = (windows?.get(ref) ?? []).filter((e) => e.time > cut);
  let total = 0;
  for (const e of entries) total += e.tokens;
  if (total < limit) return 0;
  let rem = total;
  for (const e of entries) {
    rem -= e.tokens;
    if (rem < limit) {
      return Math.max(0, e.time + WINDOW_MS - now);
    }
  }
  return WINDOW_MS;
}

/** Drop TPM state for refs that no longer exist. */
export function tpmSweep(windows, liveRefs) {
  if (!windows) return;
  for (const ref of [...windows.keys()]) {
    if (!liveRefs.has(ref)) windows.delete(ref);
  }
}

/** Snapshot for /status - used/remaining/limit/resetMs for one ref. */
export function tpmInfo(windows, ref, limit, now = Date.now()) {
  if (!limit || limit <= 0) return null;
  const cut = now - WINDOW_MS;
  const entries = (windows?.get(ref) ?? []).filter((e) => e.time > cut);
  let used = 0;
  for (const e of entries) used += e.tokens;
  return {
    used,
    remaining: Math.max(0, limit - used),
    limit,
    resetMs: used >= limit ? tpmRetryMs(windows, ref, limit, now) : 0,
  };
}
